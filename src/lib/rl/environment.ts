/**
 * The agent's world, with a reset button.
 *
 * Everything needed to train or search over a policy is already in this
 * repository — a task distribution, a typed action space, a deterministic
 * transition function, and a verifier that needs no human and no judge model.
 * It was just wired for one caller: the adaptive loop. This exposes it as a
 * plain environment so a policy that is not our agent loop can be run against
 * the same world and scored the same way.
 *
 *     const env = new SalesCaseEnv(prisma);
 *     let obs = await env.reset("refusal-no-viable-option");
 *     while (!obs.done) obs = await env.step({ tool, input });
 *     const { reward } = await env.finish();
 *
 * Three properties matter more than the interface:
 *
 *   - **Isolation.** Every episode runs against a throwaway copy of the case,
 *     never the seeded original, so one episode cannot change what the next
 *     one sees. This was already load-bearing in the eval suite: analysing a
 *     seeded case rewrites its recommendation, and REQ-2041 would otherwise
 *     carry whatever the last episode left behind.
 *   - **The action space is the MCP toolbox.** Not a convenience wrapper over
 *     the database — the same typed tools, the same effect classes, the same
 *     refusals. A policy cannot reach anything here that the product's own
 *     agent cannot reach.
 *   - **Reward comes from the verifier, not from the policy's account of
 *     itself.** `src/lib/rl/reward.ts` folds the scorer's checks into one
 *     scalar, and a critical check failing is a zero.
 *
 * What this is not: training. No weights are updated anywhere in this
 * repository, and nothing here calls a fine-tuning API. It is the environment
 * and verifier half — enough to measure a policy, search over prompts or
 * harness settings, or generate scored trajectories, and the piece a trainer
 * would plug into.
 */

import type { PrismaClient } from "@/generated/prisma";
import type { ProductView, RequirementView } from "@/lib/domain/types";
import { getAIProvider } from "@/lib/ai";
import { inferFromIncumbent } from "@/lib/ai/extract";
import { toProductView } from "@/lib/agent/mappers";
import { persistItems, persistRequirements } from "@/lib/agent/orchestrator";
import { ToolBus } from "@/lib/agent/toolbus";
import { connectMcp, type McpSession } from "@/lib/mcp/client";
import type { HandlerContext } from "@/lib/mcp/handlers";
import {
  applyToolResult,
  emptyState,
  narrateState,
  type InvestigationState,
} from "@/lib/agent/adaptive/state";
import { scenarioById, type EvalScenario } from "@/lib/eval/scenario";
import { prepareScenarioCase, scoreCompletedRun } from "@/lib/eval/runner";
import { rewardFor, type RewardBreakdown } from "./reward";

export interface EnvAction {
  tool: string;
  input: Record<string, unknown>;
}

export interface EnvObservation {
  /** The customer's message, verbatim and untrusted. */
  request: string;
  /** What tool results have established so far, in operator language. */
  established: string[];
  /** Structured state, for a policy that would rather read fields. */
  state: InvestigationState;
  /** Result of the action just taken; null on reset. */
  lastResult: { tool: string; ok: boolean; content: string } | null;
  stepsTaken: number;
  done: boolean;
}

export interface EpisodeResult {
  scenarioId: string;
  steps: number;
  terminalTool: string | null;
  reward: number;
  breakdown: RewardBreakdown;
  status: string;
}

export class SalesCaseEnv {
  private scenario: EvalScenario | null = null;
  private requestId: string | null = null;
  private session: McpSession | null = null;
  private bus: ToolBus | null = null;
  private runId: string | null = null;
  private terminal: HandlerContext["terminal"] = { called: null, payload: null };
  private state: InvestigationState = emptyState("");
  private steps = 0;
  private request = "";

  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: { maxSteps?: number; asOf?: Date } = {},
  ) {}

  /** The throwaway case this episode is running on, or null between episodes. */
  get episodeRequestId(): string | null {
    return this.requestId;
  }

  get maxSteps(): number {
    return this.options.maxSteps ?? 40;
  }

  /** Start a fresh episode on a throwaway copy of the scenario's case. */
  async reset(scenarioId: string): Promise<EnvObservation> {
    const scenario = scenarioById(scenarioId);
    if (!scenario) throw new Error(`Unknown scenario ${scenarioId}`);
    await this.close();

    const prepared = await prepareScenarioCase(this.prisma, scenario);
    const row = await this.prisma.salesRequest.findUniqueOrThrow({ where: { id: prepared.requestId } });
    await this.extractRequirements(prepared.requestId, row.subject, row.rawBody, row.siteId);

    this.scenario = scenario;
    this.requestId = prepared.requestId;
    this.state = emptyState(prepared.requestId);
    this.steps = 0;
    this.terminal = { called: null, payload: null };
    this.request = row.rawBody;
    // Tool calls belong to a run, the same as any other execution in this
    // system, so the episode's trace is inspectable afterwards exactly like a
    // production one.
    const run = await this.prisma.agentRun.create({
      data: {
        requestId: prepared.requestId,
        provider: "rl-environment",
        mode: "ADAPTIVE_AGENT",
        modelSource: "SCRIPTED",
        status: "RUNNING",
        startedAt: this.options.asOf ?? new Date(),
      },
    });
    this.runId = run.id;
    this.bus = new ToolBus({
      prisma: this.prisma,
      runId: run.id,
      requestId: prepared.requestId,
      asOf: this.options.asOf ?? new Date(),
    });
    this.session = await connectMcp({
      prisma: this.prisma,
      bus: this.bus,
      requestId: prepared.requestId,
      asOf: this.options.asOf ?? new Date(),
      terminal: this.terminal,
    });

    return this.observe(null);
  }

  /** The tools a policy may choose from, with their schemas. */
  async actionSpace(): Promise<{ name: string; description: string }[]> {
    if (!this.session) throw new Error("reset() first");
    const listed = await this.session.client.listTools();
    return listed.tools.map((t) => ({ name: t.name, description: t.description ?? "" }));
  }

  async step(action: EnvAction): Promise<EnvObservation> {
    if (!this.session || !this.requestId) throw new Error("reset() first");
    if (this.terminal.called) throw new Error("Episode is over; call finish()");

    this.steps += 1;
    const call = await this.session.client.callTool({ name: action.tool, arguments: action.input });
    const isError = Boolean((call as { isError?: boolean }).isError);
    const structured = (call as { structuredContent?: unknown }).structuredContent;
    const content = Array.isArray((call as { content?: { text?: string }[] }).content)
      ? ((call as { content: { text?: string }[] }).content[0]?.text ?? "")
      : "";

    // State only moves on results the tools actually produced, which is what
    // makes grounding meaningful later.
    if (!isError && structured) {
      this.state = applyToolResult(this.state, action.tool, structured);
    }

    return this.observe({ tool: action.tool, ok: !isError, content: content.slice(0, 2000) });
  }

  /**
   * Close the episode and score it.
   *
   * Scoring runs the same verifier the eval suite uses, so a number produced
   * here is comparable with one from `npm run eval`.
   */
  async finish(): Promise<EpisodeResult> {
    if (!this.scenario || !this.requestId) throw new Error("reset() first");
    const result = await scoreCompletedRun(this.prisma, this.scenario, this.requestId, "ADAPTIVE_AGENT");
    const breakdown = rewardFor(result);
    const episode: EpisodeResult = {
      scenarioId: this.scenario.id,
      steps: this.steps,
      terminalTool: this.terminal.called,
      reward: breakdown.reward,
      breakdown,
      status: result.status,
    };
    await this.close();
    return episode;
  }

  /** Delete the episode's copy of the case. Safe to call more than once. */
  async close(): Promise<void> {
    const id = this.requestId;
    this.requestId = null;
    this.runId = null;
    this.session = null;
    this.bus = null;
    if (id) {
      await this.prisma.salesRequest.delete({ where: { id } }).catch(() => undefined);
    }
  }

  /**
   * Deterministic extraction, exactly as it runs before the agent in
   * production.
   *
   * Without it the episode starts on a case with no requirements, every
   * compatibility check refuses for want of something to compare against, and
   * the environment would be measuring a world the product never presents to
   * its agent. The model never writes these: the extractor does, and the
   * agent reads them back through get_request_state.
   */
  private async extractRequirements(
    requestId: string,
    subject: string,
    body: string,
    siteId: string | null,
  ): Promise<void> {
    const provider = getAIProvider();
    const asOf = this.options.asOf ?? new Date();
    const [knownSkuRows, sites] = await Promise.all([
      this.prisma.product.findMany({ select: { sku: true } }),
      this.prisma.customerSite.findMany({ select: { id: true, name: true, aliases: true, city: true } }),
    ]);

    const analysis = await provider.analyzeRequest({
      subject,
      body,
      context: {
        knownSkus: knownSkuRows.map((p) => p.sku),
        siteAliases: sites.map((s) => ({ siteId: s.id, label: s.name, tokens: [...s.aliases, s.city, s.name] })),
        now: asOf,
      },
    });

    let incumbent: ProductView | null = null;
    for (const item of analysis.items) {
      if (!item.sku || incumbent) continue;
      const product = await this.prisma.product.findUnique({
        where: { sku: item.sku },
        include: { category: true, specs: true },
      });
      if (product) incumbent = toProductView(product);
    }

    let requirements: RequirementView[] = analysis.requirements;
    if (incumbent) {
      requirements = [...requirements, ...inferFromIncumbent(incumbent.sku, incumbent.specs, requirements)];
    }
    await persistRequirements(this.prisma, requestId, requirements);
    await persistItems(this.prisma, requestId, analysis.items, this.prisma);
    await this.prisma.salesRequest.update({
      where: { id: requestId },
      data: { summary: analysis.summary, requiredBy: analysis.requiredBy, siteId: analysis.siteId ?? siteId },
    });
  }

  private observe(lastResult: EnvObservation["lastResult"]): EnvObservation {
    return {
      request: this.request,
      established: narrateState(this.state),
      state: this.state,
      lastResult,
      stepsTaken: this.steps,
      done: Boolean(this.terminal.called) || this.steps >= this.maxSteps,
    };
  }
}
