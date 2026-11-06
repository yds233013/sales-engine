/**
 * The adaptive agent runtime.
 *
 * OBSERVE → DECIDE → ACT, with the model choosing every tool and the
 * application enforcing every limit. The loop itself is small; almost all the
 * code here is the boundary around it.
 *
 * ## Why a direct tool-use loop rather than the Claude Agent SDK
 *
 * The Agent SDK is built for long-lived assistant sessions with filesystem and
 * shell access and its own permission model. What this build needs is narrower
 * and stricter: a bounded loop over one MCP server, with turn and tool budgets,
 * loop detection, state validation after every call, and the ability to run
 * headless inside a Vitest process with no credentials. A direct Messages API
 * loop over the MCP client gives exactly that in ~200 lines, keeps the
 * guardrails inspectable, and leaves the MCP layer as the only tool surface —
 * which is the part that actually needed to be real.
 *
 * ## What the model cannot do here
 *
 * It cannot reach the database, choose a tool that is not registered, pass a
 * technical fact into a tool, exceed its budget, or conclude without going
 * through the deterministic finalizer. Those are properties of this file and
 * the MCP handlers, not of the prompt.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { PrismaClient } from "@/generated/prisma";
import { connectMcp } from "@/lib/mcp/client";
import { contractFor, isTerminal, TOOL_CONTRACTS, type ToolName } from "@/lib/mcp/contracts";
import type { ToolBus } from "@/lib/agent/toolbus";
import type { HandlerContext } from "@/lib/mcp/handlers";
import {
  applyToolResult,
  canDraftQuote,
  canEscalateForReview,
  canRespondWithInformation,
  emptyState,
  narrateState,
  type InvestigationState,
  type TerminationStatus,
} from "./state";
import { buildSystemPrompt, buildUserMessage } from "./prompt";
import {
  DEFAULT_GUARDRAILS,
  GuardrailTracker,
  type GuardrailConfig,
  type GuardrailEvent,
} from "./guardrails";

export interface AdaptiveRunOptions {
  asOf?: Date;
  guardrails?: Partial<GuardrailConfig>;
  /** Injected in tests so the loop can be driven without a live model. */
  modelClient?: ModelClient;
  model?: string;
}

/** The slice of the Messages API this runtime uses. */
export interface ModelClient {
  createMessage(params: {
    model: string;
    system: string;
    messages: Anthropic.MessageParam[];
    tools: Anthropic.Tool[];
    maxTokens: number;
  }): Promise<Anthropic.Message>;
}

export class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  /**
   * Two cache breakpoints, because an agent loop re-sends everything it has
   * already said on every turn.
   *
   * The first covers the system prompt and the fifteen tool schemas — roughly
   * 4,400 tokens that are byte-identical on every call of every run. The
   * second covers the conversation so far, which is where the real growth is:
   * tool results accumulate, and by the last turn the transcript is most of
   * the bill. Marking the final block means each turn pays full price only for
   * what is new.
   *
   * This changes cost, not behaviour. The request is otherwise identical, and
   * a cache miss simply bills normally.
   */
  async createMessage(params: Parameters<ModelClient["createMessage"]>[0]): Promise<Anthropic.Message> {
    return this.client.messages.create({
      model: params.model,
      system: [{ type: "text", text: params.system, cache_control: { type: "ephemeral" } }],
      messages: withConversationCacheBreakpoint(params.messages),
      tools: withToolsCacheBreakpoint(params.tools),
      max_tokens: params.maxTokens,
    });
  }
}

/** Mark the last tool so the whole tool-schema block is cached. */
function withToolsCacheBreakpoint(tools: Anthropic.Tool[]): Anthropic.Tool[] {
  if (tools.length === 0) return tools;
  return tools.map((tool, index) =>
    index === tools.length - 1 ? { ...tool, cache_control: { type: "ephemeral" as const } } : tool,
  );
}

/**
 * Mark the end of the transcript, so the next turn reads it from cache.
 *
 * Only block-shaped content can carry the marker, so a plain string message is
 * promoted to a single text block. Anything unexpected is left alone: a missed
 * cache costs money, a malformed request costs the run.
 */
function withConversationCacheBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const out = [...messages];
  const last = out[out.length - 1];

  if (typeof last.content === "string") {
    out[out.length - 1] = {
      ...last,
      content: [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }],
    };
    return out;
  }
  if (!Array.isArray(last.content) || last.content.length === 0) return out;

  const blocks = [...last.content];
  const tail = blocks[blocks.length - 1];
  if (!tail || typeof tail !== "object") return out;
  blocks[blocks.length - 1] = { ...tail, cache_control: { type: "ephemeral" } } as (typeof blocks)[number];
  out[out.length - 1] = { ...last, content: blocks };
  return out;
}

export interface AdaptiveResult {
  runId: string;
  termination: TerminationStatus;
  state: InvestigationState;
  terminalTool: ToolName | null;
  terminalPayload: unknown;
  steps: string[];
  guardrailEvents: GuardrailEvent[];
  turnCount: number;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  errorCategory: string | null;
  error: string | null;
}

/** Per-million-token list prices, used only when the API reports usage. */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-opus-5": { input: 15, output: 75 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

/**
 * Cache multipliers, per Anthropic's published pricing: writing a cache entry
 * costs 1.25x the base input rate, reading one costs 0.1x.
 */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
}

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens = 0,
  cacheReadTokens = 0,
): number | null {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return null;
  if (inputTokens === 0 && outputTokens === 0 && cacheWriteTokens === 0 && cacheReadTokens === 0) return null;
  const cost =
    (inputTokens / 1e6) * pricing.input +
    (outputTokens / 1e6) * pricing.output +
    (cacheWriteTokens / 1e6) * pricing.input * CACHE_WRITE_MULTIPLIER +
    (cacheReadTokens / 1e6) * pricing.input * CACHE_READ_MULTIPLIER;
  return Number(cost.toFixed(6));
}

/** Contracts → Anthropic tool definitions. The model sees exactly what MCP exposes. */
export function toolDefinitions(): Anthropic.Tool[] {
  return (Object.entries(TOOL_CONTRACTS) as [ToolName, (typeof TOOL_CONTRACTS)[ToolName]][]).map(
    ([name, contract]) => ({
      name,
      description: contract.description,
      input_schema: zodObjectToJsonSchema(contract.input),
    }),
  );
}

/**
 * Minimal Zod → JSON Schema for the flat, primitive-typed tool inputs this
 * registry uses. Deliberately narrow: it throws on anything it does not
 * understand rather than silently emitting a schema that lets bad arguments
 * through.
 */
function zodObjectToJsonSchema(schema: {
  shape: Record<string, unknown>;
}): Anthropic.Tool["input_schema"] {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, raw] of Object.entries(schema.shape)) {
    const { node, optional } = describeZod(raw);
    properties[key] = node;
    if (!optional) required.push(key);
  }
  return { type: "object", properties, required } as Anthropic.Tool["input_schema"];
}

/**
 * Pull Zod's validation checks into the JSON Schema the model is shown.
 *
 * Without this the model sees `{type: "array", items: {type: "string"}}` for a
 * field that is really "1 to 6 questions, each 8 to 300 characters" — and the
 * first it learns of the real bound is a -32602 rejection that costs a turn.
 * A constraint the validator enforces but the schema does not advertise is a
 * trap, not a contract.
 */
function applyChecks(node: Record<string, unknown>, current: unknown, kind: "string" | "number" | "array"): void {
  const checks = ((current as { _def?: { checks?: unknown[] } })?._def?.checks ?? []) as unknown[];
  for (const raw of checks) {
    const def = ((raw as { _zod?: { def?: unknown }; def?: unknown })?._zod?.def ??
      (raw as { def?: unknown })?.def ??
      raw) as { check?: string; minimum?: number; maximum?: number; value?: number; inclusive?: boolean };
    switch (def.check) {
      case "min_length":
        if (kind === "string") node.minLength = def.minimum;
        else if (kind === "array") node.minItems = def.minimum;
        break;
      case "max_length":
        if (kind === "string") node.maxLength = def.maximum;
        else if (kind === "array") node.maxItems = def.maximum;
        break;
      case "greater_than":
        if (typeof def.value === "number") node.minimum = def.inclusive ? def.value : def.value + 1;
        break;
      case "less_than":
        if (typeof def.value === "number") node.maximum = def.inclusive ? def.value : def.value - 1;
        break;
      case "number_format":
        node.type = "integer";
        break;
      default:
        break;
    }
  }
}

function describeZod(raw: unknown): { node: Record<string, unknown>; optional: boolean } {
  let current = raw as { _def?: Record<string, unknown>; description?: string };
  let optional = false;
  const description = (current as { description?: string }).description;

  // Unwrap optional/default/nullable wrappers.
  for (let depth = 0; depth < 6; depth += 1) {
    const typeName = (current?._def?.typeName ?? current?._def?.type) as string | undefined;
    if (typeName === "ZodOptional" || typeName === "optional" || typeName === "ZodDefault" || typeName === "default") {
      optional = true;
      current = (current._def as { innerType: typeof current }).innerType;
      continue;
    }
    if (typeName === "ZodNullable" || typeName === "nullable") {
      current = (current._def as { innerType: typeof current }).innerType;
      continue;
    }
    break;
  }

  const typeName = (current?._def?.typeName ?? current?._def?.type) as string | undefined;
  const node: Record<string, unknown> = {};
  const desc = description ?? (current as { description?: string }).description;
  if (desc) node.description = desc;

  switch (typeName) {
    case "ZodString":
    case "string":
      node.type = "string";
      applyChecks(node, current, "string");
      break;
    case "ZodNumber":
    case "number":
      node.type = "number";
      applyChecks(node, current, "number");
      break;
    case "ZodBoolean":
    case "boolean":
      node.type = "boolean";
      break;
    case "ZodArray":
    case "array": {
      node.type = "array";
      const element = (current._def as { type?: unknown; element?: unknown }).element ??
        (current._def as { type?: unknown }).type;
      node.items = describeZod(element).node;
      applyChecks(node, current, "array");
      break;
    }
    case "ZodEnum":
    case "enum": {
      node.type = "string";
      const values = (current._def as { values?: unknown }).values;
      node.enum = Array.isArray(values) ? values : Object.values(values ?? {});
      break;
    }
    case "ZodObject":
    case "object":
      node.type = "object";
      break;
    default:
      throw new Error(`Tool input schema uses an unsupported Zod type: ${typeName ?? "unknown"}`);
  }
  return { node, optional };
}

/**
 * Run one case adaptively.
 *
 * Persists nothing about the recommendation itself — that is the finalizer's
 * job. This returns what the agent established and how it wants to conclude.
 */
export async function runAdaptiveLoop(
  prisma: PrismaClient,
  requestId: string,
  runId: string,
  bus: ToolBus,
  modelClient: ModelClient,
  model: string,
  options: AdaptiveRunOptions = {},
): Promise<AdaptiveResult> {
  const asOf = options.asOf ?? new Date();
  const config = { ...DEFAULT_GUARDRAILS, ...options.guardrails };
  const tracker = new GuardrailTracker(config);

  const request = await prisma.salesRequest.findUniqueOrThrow({ where: { id: requestId } });
  // The parts the customer actually named, as the deterministic extractor
  // recorded them. Read here rather than taken from the model's arguments, so
  // the escalation gate cannot be satisfied by naming a different part.
  const requestedSkus = (
    await prisma.requestItem.findMany({
      where: { requestId, productId: { not: null } },
      select: { product: { select: { sku: true } } },
    })
  )
    .map((item) => item.product?.sku)
    .filter((sku): sku is string => Boolean(sku));
  const terminal: HandlerContext["terminal"] = { called: null, payload: null };
  const ctx: HandlerContext = { prisma, bus, requestId, asOf, terminal };

  const session = await connectMcp(ctx);
  let state = emptyState(requestId);
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  const errorCategory: string | null = null;
  let error: string | null = null;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: buildUserMessage(request.subject, request.rawBody, request.reference) },
  ];
  const tools = toolDefinitions();
  const system = buildSystemPrompt();

  try {
    while (true) {
      const stop = tracker.stopReason();
      if (stop) {
        return finish("GUARDRAIL_STOP", stop.kind === "TIMEOUT" ? "TIMEOUT" : "GUARDRAIL");
      }

      tracker.turn += 1;

      let response: Anthropic.Message;
      try {
        response = await modelClient.createMessage({
          model,
          system,
          messages,
          tools,
          maxTokens: 4096,
        });
      } catch (modelError) {
        // A provider failure is not a safety event — it is an outage. The run
        // ends cleanly and the caller decides whether to fall back.
        error = modelError instanceof Error ? modelError.message : String(modelError);
        tracker.record("MODEL_ERROR", error);
        return finish("FAILED", "PROVIDER_ERROR");
      }

      inputTokens += response.usage?.input_tokens ?? 0;
      outputTokens += response.usage?.output_tokens ?? 0;
      // Cached tokens are billed separately and are not included in
      // `input_tokens`, so they are tracked separately rather than folded in —
      // otherwise the reported cost would silently understate the run.
      cacheWriteTokens += response.usage?.cache_creation_input_tokens ?? 0;
      cacheReadTokens += response.usage?.cache_read_input_tokens ?? 0;
      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );

      if (toolUses.length === 0) {
        // The model stopped talking without concluding. Nudge once; if it does
        // it again the turn limit will end the run.
        messages.push({
          role: "user",
          content:
            "You have not taken a terminal action. Finish with create_quote_draft, request_clarification or escalate_for_review.",
        });
        tracker.record("NO_TERMINAL_ACTION", "Model produced no tool call.");
        continue;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];

      for (const use of toolUses) {
        // Checked per call, not per turn. A single turn can request many tools
        // at once, so a cap enforced only at the top of the loop would let one
        // greedy turn run straight past it before anything noticed.
        const capped = tracker.toolBudgetExhausted();
        if (capped) {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            is_error: true,
            content: `Stopped: ${capped.detail}`,
          });
          continue;
        }

        tracker.toolCalls += 1;
        const contract = contractFor(use.name);

        if (!contract) {
          tracker.record("UNKNOWN_TOOL", use.name);
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            is_error: true,
            content: `There is no tool called "${use.name}". Use one of the tools you were given.`,
          });
          continue;
        }

        const repeat = tracker.checkRepeat(use.name, use.input);
        if (repeat) {
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: repeat });
          continue;
        }

        // Preconditions for a quote draft are checked before the terminal
        // action is spent, so the model gets a chance to fix the gap.
        if (use.name === "create_quote_draft") {
          const candidates = ((use.input as { candidateSkus?: string[] }).candidateSkus ?? []).map((s) =>
            s.toUpperCase(),
          );
          const ready = canDraftQuote(state, candidates);
          if (!ready.ok) {
            tracker.record("FORBIDDEN_EFFECT", ready.reason);
            results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: ready.reason });
            continue;
          }
        }

        // The same gate for an informational answer: every citation must be
        // one retrieval returned in this run, and every part named must be one
        // this run looked up. Without it the tool would be a way to assert
        // anything at all and call it a conclusion.
        if (use.name === "respond_with_information") {
          const payload = use.input as { evidenceRefs?: string[]; skus?: string[] };
          const ready = canRespondWithInformation(state, {
            evidenceRefs: payload.evidenceRefs ?? [],
            skus: payload.skus ?? [],
          });
          if (!ready.ok) {
            tracker.record("FORBIDDEN_EFFECT", ready.reason);
            results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: ready.reason });
            continue;
          }
        }

        // Escalating is a claim about the catalog, so it carries the same
        // kind of precondition as an informational answer: the requested part
        // examined, and at least one search for an alternative.
        if (use.name === "escalate_for_review") {
          const ready = canEscalateForReview(state, { requestedSkus });
          if (!ready.ok) {
            tracker.record("FORBIDDEN_EFFECT", ready.reason);
            results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: ready.reason });
            continue;
          }
        }

        const callResult = await session.client.callTool({
          name: use.name,
          arguments: (use.input ?? {}) as Record<string, unknown>,
        });

        const isError = Boolean((callResult as { isError?: boolean }).isError);
        const structured = (callResult as { structuredContent?: unknown }).structuredContent;
        const textContent = Array.isArray((callResult as { content?: { text?: string }[] }).content)
          ? ((callResult as { content: { text?: string }[] }).content[0]?.text ?? "")
          : "";

        if (isError) {
          const abandon = tracker.noteInvalid(use.name, textContent.slice(0, 200));
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: textContent });
          if (abandon) {
            return finish("GUARDRAIL_STOP", "REPEATED_INVALID_ARGS");
          }
          continue;
        }

        tracker.noteValid();
        state = applyToolResult(state, use.name, structured);
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: JSON.stringify(structured ?? {}),
        });

        if (isTerminal(use.name) && terminal.called) {
          messages.push({ role: "user", content: results });
          return finish(terminationFor(terminal.called), null);
        }
      }

      messages.push({ role: "user", content: results });
    }
  } finally {
    await session.close().catch(() => undefined);
  }

  function finish(termination: TerminationStatus, category: string | null): AdaptiveResult {
    return {
      runId,
      termination,
      state,
      terminalTool: terminal.called,
      terminalPayload: terminal.payload,
      steps: narrateState(state),
      guardrailEvents: tracker.events,
      turnCount: tracker.turn,
      toolCallCount: tracker.toolCalls,
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      errorCategory: category ?? errorCategory,
      error,
    };
  }
}

function terminationFor(tool: ToolName): TerminationStatus {
  switch (tool) {
    case "create_quote_draft":
      return "READY_TO_DRAFT";
    case "respond_with_information":
      return "INFORMATION_PROVIDED";
    case "request_clarification":
      return "NEEDS_CUSTOMER_CLARIFICATION";
    case "escalate_for_review":
      return "NEEDS_INTERNAL_REVIEW";
    default:
      return "FAILED";
  }
}
