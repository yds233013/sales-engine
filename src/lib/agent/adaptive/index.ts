/**
 * Adaptive execution: run a case with the model directing the investigation.
 *
 * The shape of a run:
 *
 *   1. Deterministic extraction runs first and persists the requirements.
 *      This is not a shortcut — it is the grounding anchor. Every compatibility
 *      check runs against these, and the agent cannot supply its own.
 *   2. The agent investigates over MCP, choosing its own tools.
 *   3. Its terminal action is handed to the *same* deterministic finalizer the
 *      fixed pipeline uses, which re-validates everything and owns the quote,
 *      the approvals and the numbers.
 *   4. The structured outcome is schema-validated and grounding-checked before
 *      it is allowed to stand.
 *
 * Step 3 is the whole architecture. The agent decides what to look at. It
 * never decides what is true.
 */

import type { PrismaClient } from "@/generated/prisma";
import type { ProductView, RequirementView } from "@/lib/domain/types";
import { getAIProvider } from "@/lib/ai";
import { adaptiveApiKey, adaptiveModel, liveAdaptivePolicy } from "@/lib/ai/capability";
import { takeLiveRunSlot } from "@/lib/ai/rate-limit";
import { inferFromIncumbent } from "@/lib/ai/extract";
import { recordAudit } from "@/lib/audit";
import { ToolBus } from "@/lib/agent/toolbus";
import { toProductView, toRuleView } from "@/lib/agent/mappers";
import {
  finalizeCase,
  finishAsInformationRequired,
  finishRun,
  persistItems,
  persistRequirements,
  gapToQuestion,
  type RunOutcome,
} from "@/lib/agent/orchestrator";
import { resolveCustomer, type SubstituteCandidate } from "@/lib/agent/tools";
import { evaluateCandidate } from "@/lib/engines/compatibility";
import {
  AnthropicModelClient,
  runAdaptiveLoop,
  estimateCostUsd,
  type AdaptiveResult,
  type ModelClient,
  type AdaptiveRunOptions,
} from "./runtime";
import {
  agentOutcomeSchema,
  checkGrounding,
  type AgentOutcome,
  type AuthoritativeVerdict,
  type GroundingCatalog,
} from "./outcome";
import { narrateState, type TerminationStatus } from "./state";

const PRODUCT_INCLUDE = { category: true, specs: true } as const;

export class AdaptiveUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdaptiveUnavailableError";
  }
}

export interface AdaptiveOutcome extends RunOutcome {
  termination: TerminationStatus;
  agentOutcome: AgentOutcome | null;
  groundingIssues: string[];
  toolSequence: string[];
  turnCount: number;
  toolCallCount: number;
}

export async function runAdaptiveRequest(
  prisma: PrismaClient,
  requestId: string,
  options: AdaptiveRunOptions = {},
): Promise<AdaptiveOutcome> {
  const apiKey = adaptiveApiKey();
  // A caller-supplied client is a scripted stand-in; only a client we build
  // from real credentials talks to a provider. Recording which of the two ran
  // is the difference between reporting a live agent result and inventing one.
  const scripted = Boolean(options.modelClient);

  // The spend gate, enforced here because every live model call in the
  // product passes through this function — the case page, the Lab console, the
  // eval suite and the CLI. A scripted client bills nothing and is exempt.
  if (!scripted) {
    const policy = liveAdaptivePolicy();
    if (!policy.allowed) throw new AdaptiveUnavailableError(policy.reason ?? "Live adaptive execution is not available.");
    if (!takeLiveRunSlot()) {
      throw new AdaptiveUnavailableError(
        "The hourly limit on live model runs for this deployment has been reached. Try again later, or use the deterministic workflow.",
      );
    }
  }

  const modelClient: ModelClient | null = options.modelClient ?? (apiKey ? new AnthropicModelClient(apiKey) : null);
  if (!modelClient) {
    throw new AdaptiveUnavailableError(
      "Adaptive mode needs a configured model provider. Set ANTHROPIC_API_KEY, or run the deterministic workflow.",
    );
  }
  const model = options.model ?? adaptiveModel();
  const asOf = options.asOf ?? new Date();
  const provider = getAIProvider();

  const request = await prisma.salesRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { customer: { include: { sites: true } } },
  });

  await prisma.$transaction([
    prisma.recommendation.deleteMany({ where: { requestId } }),
    prisma.quote.deleteMany({ where: { requestId } }),
    prisma.approval.deleteMany({ where: { requestId } }),
    prisma.requirement.deleteMany({ where: { requestId } }),
    prisma.requestItem.deleteMany({ where: { requestId } }),
    prisma.customerResponse.deleteMany({ where: { requestId } }),
    prisma.agentRun.deleteMany({ where: { requestId } }),
  ]);

  const run = await prisma.agentRun.create({
    data: {
      requestId,
      provider: provider.id,
      mode: "ADAPTIVE_AGENT",
      model,
      modelSource: scripted ? "SCRIPTED" : "LIVE",
      status: "RUNNING",
      startedAt: asOf,
    },
  });
  const startedAt = Date.now();

  await prisma.salesRequest.update({ where: { id: requestId }, data: { status: "ANALYZING" } });
  await recordAudit(prisma, requestId, {
    type: "RUN_STARTED",
    actor: "Sales Engine",
    summary: `Adaptive investigation started (${model}${scripted ? ", scripted stand-in" : ""}). Tool selection is model-directed; compatibility, stock, pricing and approvals remain deterministic.`,
    detail: { mode: "ADAPTIVE_AGENT", model, modelSource: scripted ? "SCRIPTED" : "LIVE" },
  });

  try {
    // ── 1. Deterministic extraction — the grounding anchor ─────────────────
    const [knownSkuRows, knownDocRows, knownCaseRows, sites] = await Promise.all([
      prisma.product.findMany({ select: { sku: true } }),
      prisma.technicalDocument.findMany({ select: { docNumber: true } }),
      prisma.salesRequest.findMany({ select: { reference: true } }),
      prisma.customerSite.findMany({ select: { id: true, name: true, aliases: true, city: true } }),
    ]);

    const analysis = await provider.analyzeRequest({
      subject: request.subject,
      body: request.rawBody,
      context: {
        knownSkus: knownSkuRows.map((p) => p.sku),
        siteAliases: sites.map((s) => ({ siteId: s.id, label: s.name, tokens: [...s.aliases, s.city, s.name] })),
        now: asOf,
      },
    });

    let incumbent: ProductView | null = null;
    for (const item of analysis.items) {
      if (!item.sku || incumbent) continue;
      const row = await prisma.product.findUnique({ where: { sku: item.sku }, include: PRODUCT_INCLUDE });
      if (row) incumbent = toProductView(row);
    }

    let requirements: RequirementView[] = analysis.requirements;
    if (incumbent) {
      requirements = [...requirements, ...inferFromIncumbent(incumbent.sku, incumbent.specs, requirements)];
    }
    await persistRequirements(prisma, requestId, requirements);
    await persistItems(prisma, requestId, analysis.items, prisma);
    await prisma.salesRequest.update({
      where: { id: requestId },
      data: { summary: analysis.summary, requiredBy: analysis.requiredBy, siteId: analysis.siteId ?? request.siteId },
    });

    // ── 2. The agent investigates ──────────────────────────────────────────
    //
    // One bus for the whole run: the agent's calls and the finalizer's calls
    // share a single ordered sequence, so the trace reads as one story rather
    // than two interleaved series with colliding numbers.
    const bus = new ToolBus({ prisma, runId: run.id, requestId, asOf });
    const result = await runAdaptiveLoop(prisma, requestId, run.id, bus, modelClient, model, options);

    // ── 3. Deterministic finalization ──────────────────────────────────────
    const account = await resolveCustomer(bus, {
      customerId: request.customerId,
      siteHint: analysis.siteId,
      bodyText: `${request.subject}\n${request.rawBody}`,
    });

    // The resolved site and contact belong on the case whichever mode produced
    // them; the earlier update only had the extractor's site guess to work with.
    await prisma.salesRequest.update({
      where: { id: requestId },
      data: { siteId: account.siteId, contactId: account.contactId },
    });

    const catalog: GroundingCatalog = {
      skus: new Set(knownSkuRows.map((r) => r.sku)),
      documents: new Set(knownDocRows.map((r) => r.docNumber)),
      caseReferences: new Set(knownCaseRows.map((r) => r.reference.toUpperCase())),
    };
    const quantityReq = requirements.find((r) => r.key === "quantity");
    const quantity = quantityReq?.kind === "EXPLICIT" ? Number(quantityReq.numValue) : null;

    const finished = await concludeRun({
      prisma,
      bus,
      provider,
      run,
      request,
      result,
      account,
      incumbent,
      requirements,
      quantity,
      analysis,
      asOf,
      startedAt,
      catalog,
      model,
    });

    return finished;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        termination: "FAILED",
        error: message,
        errorCategory: "RUNTIME_ERROR",
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
      },
    });
    await prisma.salesRequest.update({
      where: { id: requestId },
      data: {
        status: "NEEDS_REVIEW",
        risk: "HIGH",
        blockedReason: `Adaptive run did not complete: ${message.split("\n")[0]}. Run the deterministic workflow instead.`,
      },
    });
    await recordAudit(prisma, requestId, {
      type: "RUN_FAILED",
      actor: "Sales Engine",
      summary: `Adaptive investigation stopped: ${message.split("\n")[0]}`,
    });
    throw error;
  }
}

// ──────────────────────── terminal action handling ─────────────────────────

interface ConcludeArgs {
  prisma: PrismaClient;
  bus: ToolBus;
  provider: ReturnType<typeof getAIProvider>;
  run: { id: string };
  request: { id: string; subject: string; ownerId: string | null; customerId: string | null };
  result: AdaptiveResult;
  account: Awaited<ReturnType<typeof resolveCustomer>>;
  incumbent: ProductView | null;
  requirements: RequirementView[];
  quantity: number | null;
  analysis: { openQuestions: string[] };
  asOf: Date;
  startedAt: number;
  catalog: GroundingCatalog;
  model: string;
}

async function concludeRun(args: ConcludeArgs): Promise<AdaptiveOutcome> {
  const { prisma, bus, provider, run, request, result, account, incumbent, requirements, quantity } = args;
  const requestId = request.id;

  const toolSequence = (
    await prisma.toolCall.findMany({
      where: { runId: run.id },
      orderBy: { sequence: "asc" },
      select: { toolName: true },
    })
  ).map((c) => c.toolName);

  const persistMeta = async (
    termination: TerminationStatus,
    groundingIssues: string[],
    outcome: AgentOutcome | null,
  ) => {
    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        termination,
        turnCount: result.turnCount,
        toolCallCount: result.toolCallCount,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheWriteTokens: result.cacheWriteTokens,
        cacheReadTokens: result.cacheReadTokens,
        estimatedCostUsd: estimateCostUsd(
          args.model,
          result.inputTokens,
          result.outputTokens,
          result.cacheWriteTokens,
          result.cacheReadTokens,
        ),
        guardrailEvents: result.guardrailEvents as unknown as object,
        groundingIssues,
        outcome: outcome ? (outcome as unknown as object) : undefined,
        errorCategory: result.errorCategory,
        error: result.error,
        // Derived from investigation state, so it can only describe work a
        // tool actually did. Not a post-hoc narration of the run.
        trace: narrateState(result.state) as unknown as object,
      },
    });
    if (groundingIssues.length > 0) {
      await recordAudit(prisma, requestId, {
        type: "GROUNDING_REJECTED",
        actor: "Sales Engine",
        summary: `${groundingIssues.length} unsupported claim(s) in the agent's summary were rejected; the case was routed for review.`,
        detail: { issues: groundingIssues },
      });
    }
  };

  // ── The agent could not conclude ────────────────────────────────────────
  if (!result.terminalTool) {
    await persistMeta(result.termination, [], null);
    await finishRun(prisma, run.id, bus, args.startedAt, "COMPLETED");
    await prisma.salesRequest.update({
      where: { id: requestId },
      data: {
        status: "NEEDS_REVIEW",
        risk: "HIGH",
        blockedReason:
          result.termination === "FAILED"
            ? "The model provider failed mid-investigation. Run the deterministic workflow instead."
            : "The adaptive agent hit a guardrail before reaching a conclusion. Run the deterministic workflow, or work the case by hand.",
      },
    });
    await recordAudit(prisma, requestId, {
      type: "AGENT_ESCALATED",
      actor: "Sales Engine",
      summary:
        result.guardrailEvents.length > 0
          ? `Stopped by a guardrail: ${result.guardrailEvents[result.guardrailEvents.length - 1].detail}`
          : "Stopped without reaching a conclusion.",
      detail: { guardrails: result.guardrailEvents },
    });
    return {
      runId: run.id,
      status: "NEEDS_REVIEW",
      recommendationId: null,
      quoteId: null,
      approvalCount: 0,
      termination: result.termination,
      agentOutcome: null,
      groundingIssues: [],
      toolSequence,
      turnCount: result.turnCount,
      toolCallCount: result.toolCallCount,
    };
  }

  // ── Clarification ───────────────────────────────────────────────────────
  if (result.terminalTool === "request_clarification") {
    const payload = result.terminalPayload as { questions: string[]; reason: string };
    const outcome = buildOutcome(result, requestId, "NEEDS_CUSTOMER_CLARIFICATION", {
      summary: payload.reason,
      missingInformation: payload.questions,
      selected: null,
    });
    const issues = validate(outcome, result, args.catalog);

    // These questions get drafted into a letter to the customer. If any of
    // them carries a claim no tool supported — an invented part number, a
    // price, internal margin language — the agent's wording is dropped
    // entirely and the case goes to a person. Escalate, do not guess.
    const trusted = issues.length === 0;
    const termination: TerminationStatus = trusted ? "NEEDS_CUSTOMER_CLARIFICATION" : "NEEDS_INTERNAL_REVIEW";
    await persistMeta(termination, issues, outcome);

    const finishedOutcome = await finishAsInformationRequired(
      prisma,
      bus,
      run.id,
      requestId,
      provider,
      account,
      trusted ? [...payload.questions, ...args.analysis.openQuestions] : args.analysis.openQuestions,
      [],
      request.subject,
      args.startedAt,
    );
    if (!trusted) {
      await prisma.salesRequest.update({
        where: { id: requestId },
        data: {
          status: "NEEDS_REVIEW",
          risk: "HIGH",
          blockedReason: `The agent's clarification questions contained ${issues.length} unsupported claim(s) and were withheld: ${issues[0]}`,
        },
      });
    }
    return {
      ...finishedOutcome,
      status: trusted ? finishedOutcome.status : "NEEDS_REVIEW",
      termination,
      agentOutcome: outcome,
      groundingIssues: issues,
      toolSequence,
      turnCount: result.turnCount,
      toolCallCount: result.toolCallCount,
    };
  }

  // ── Informational answer ────────────────────────────────────────────────
  //
  // The customer asked a question. Nothing is priced, quoted or approved here,
  // and the deterministic finalizer is never invoked — which is what makes
  // "answering" structurally incapable of producing commercial commitments.
  if (result.terminalTool === "respond_with_information") {
    const payload = result.terminalPayload as {
      answer: string;
      claims: string[];
      evidenceRefs: string[];
      skus: string[];
      uncertainty: string | null;
    };

    const outcome = buildOutcome(result, requestId, "INFORMATION_PROVIDED", {
      summary: payload.answer,
      missingInformation: payload.uncertainty ? [payload.uncertainty] : [],
      selected: null,
      claims: payload.claims,
      evidence: payload.evidenceRefs,
    });

    // The same validator every other conclusion goes through. The answer and
    // each claim are graded against what tools returned — an invented price,
    // stock figure, part number or citation is rejected here exactly as it
    // would be in a recommendation.
    const issues = validate(outcome, result, args.catalog);
    const grounded = issues.length === 0;
    await persistMeta(grounded ? "INFORMATION_PROVIDED" : "NEEDS_INTERNAL_REVIEW", issues, outcome);

    await prisma.recommendation.create({
      data: {
        requestId,
        outcome: grounded ? "INFORMATION_PROVIDED" : "INFORMATION_REQUIRED",
        headline: grounded
          ? `Question answered from ${payload.evidenceRefs.length} cited section(s)`
          : "Answer withheld — unsupported claims",
        rationale: grounded
          ? payload.answer
          : `The agent's answer contained ${issues.length} claim(s) no tool supported and was not drafted.`,
        risk: grounded ? "LOW" : "HIGH",
      },
    });

    if (grounded) {
      // A draft, never a send. The rep reviews it and completes the case.
      await prisma.customerResponse.create({
        data: {
          requestId,
          subject: `Re: ${request.subject}`,
          body: composeInformationalLetter(args.account, payload),
        },
      });
      await prisma.salesRequest.update({
        where: { id: requestId },
        data: { status: "RESPONSE_READY", risk: "LOW", blockedReason: null },
      });
      await recordAudit(prisma, requestId, {
        type: "RESPONSE_DRAFTED",
        actor: "Sales Engine",
        summary: `Answered the customer's question from ${payload.evidenceRefs.length} cited section(s). No quotation was produced — none was requested.`,
        detail: { evidenceRefs: payload.evidenceRefs, skus: payload.skus },
      });
    } else {
      await prisma.salesRequest.update({
        where: { id: requestId },
        data: {
          status: "NEEDS_REVIEW",
          risk: "HIGH",
          blockedReason: `The agent's answer contained ${issues.length} claim(s) no tool supported: ${issues[0]}`,
        },
      });
    }

    await finishRun(prisma, run.id, bus, args.startedAt, "COMPLETED");
    return {
      runId: run.id,
      status: grounded ? "RESPONSE_READY" : "NEEDS_REVIEW",
      recommendationId: null,
      quoteId: null,
      approvalCount: 0,
      termination: grounded ? "INFORMATION_PROVIDED" : "NEEDS_INTERNAL_REVIEW",
      agentOutcome: outcome,
      groundingIssues: issues,
      toolSequence,
      turnCount: result.turnCount,
      toolCallCount: result.toolCallCount,
    };
  }

  // ── Escalation ──────────────────────────────────────────────────────────
  if (result.terminalTool === "escalate_for_review") {
    const payload = result.terminalPayload as { reason: string; blockingDimensions: string[] };
    const outcome = buildOutcome(result, requestId, "NEEDS_INTERNAL_REVIEW", {
      summary: payload.reason,
      missingInformation: [],
      selected: null,
    });
    const issues = validate(outcome, result, args.catalog);
    await persistMeta("NEEDS_INTERNAL_REVIEW", issues, outcome);

    const blockedSkus = result.state.compatibility.filter((c) => c.safety === "BLOCKED");

    // `escalate_for_review` is classified HUMAN_GATED_MUTATION, and that has to
    // be literally true: the escalation raises a pending approval that a named
    // role must decide. Marking the case BLOCKED and leaving it in nobody's
    // queue would make the classification decorative.
    await prisma.approval.create({
      data: {
        requestId,
        kind: "TECHNICAL_UNCERTAINTY",
        status: "PENDING",
        requiredRole: "APPLICATION_ENGINEER",
        title: "Specialist review requested by the adaptive agent",
        reason: payload.reason.slice(0, 2000),
        proposedAction:
          "Review the investigation and decide whether this can be met from catalog product, a special, or not at all.",
        commercialImpact: "No quotation was produced; nothing has been offered to the customer.",
        technicalImpact:
          blockedSkus.length > 0
            ? `${blockedSkus.length} candidate(s) failed a hard requirement: ${blockedSkus
                .map((c) => `${c.sku} (${c.hardFailures.map((f) => f.dimension).join(", ")})`)
                .join("; ")}`
            : "No candidate could be established as safe from the evidence gathered.",
        riskNote:
          "Escalated rather than answered. The agent did not decide this and cannot: only a named engineer can.",
        context: {
          blockingDimensions: payload.blockingDimensions ?? [],
          candidatesEvaluated: result.state.compatibility.map((c) => ({ sku: c.sku, safety: c.safety })),
        } as object,
        requestedById: request.ownerId,
      },
    });

    // Record what the run actually examined, the same way the fixed pipeline
    // does. Without this the escalation produced a recommendation with no
    // candidates at all: the engineer who picks the case up could not tell a
    // part that was ruled out from one that was never opened, and the eval
    // scored the case as thinner than the work that was really done. The
    // verdicts are re-derived from the engine over stored specs, never taken
    // from the model's account of them.
    const examinedSkus = result.state.compatibility.map((c) => c.sku);
    const examined = examinedSkus.length
      ? await prisma.product.findMany({
          where: { sku: { in: examinedSkus } },
          include: PRODUCT_INCLUDE,
        })
      : [];
    const rules = (await prisma.compatibilityRule.findMany({ orderBy: { code: "asc" } })).map(toRuleView);
    const examinedCandidates = examined.map((row, index) => {
      const verdict = evaluateCandidate(toProductView(row), requirements, rules);
      const hardFailures = verdict.checks.filter((c) => c.result === "FAIL" && c.severity === "HARD");
      return {
        productId: row.id,
        verdict: hardFailures.length > 0 ? ("REJECTED" as const) : ("REQUIRES_REVIEW" as const),
        rank: index + 1,
        reason:
          hardFailures.length > 0
            ? `Fails ${hardFailures.map((c) => c.dimension).join(", ")}.`
            : "Examined during the investigation; no hard failure, but the case was escalated before selection.",
        score: 0,
        checks: {
          create: verdict.checks.map((check) => ({
            dimension: check.dimension,
            label: check.label,
            result: check.result,
            severity: check.severity,
            requirement: check.requirement,
            actual: check.actual,
            detail: check.detail,
            ruleCode: check.ruleCode,
          })),
        },
      };
    });

    await prisma.recommendation.create({
      data: {
        requestId,
        outcome: "NO_VIABLE_OPTION",
        headline:
          blockedSkus.length > 0
            ? `No catalog product satisfies this requirement — ${blockedSkus.length} candidate(s) evaluated and rejected`
            : "Escalated for specialist review",
        rationale: payload.reason,
        risk: "BLOCKED",
        candidates: { create: examinedCandidates },
      },
    });
    await finishRun(prisma, run.id, bus, args.startedAt, "COMPLETED");
    await prisma.salesRequest.update({
      where: { id: requestId },
      data: {
        status: "BLOCKED",
        risk: "BLOCKED",
        blockedReason: payload.blockingDimensions?.length
          ? `Cannot be met from catalog product: ${payload.blockingDimensions.join(", ")}.`
          : payload.reason,
      },
    });
    await recordAudit(prisma, requestId, {
      type: "APPROVAL_REQUESTED",
      actor: "Sales Engine",
      summary: "Specialist review requested by the adaptive agent",
      detail: { kind: "TECHNICAL_UNCERTAINTY", requiredRole: "APPLICATION_ENGINEER" },
    });
    await recordAudit(prisma, requestId, {
      type: "RECOMMENDATION_BLOCKED",
      actor: "Sales Engine",
      summary: payload.reason.slice(0, 200),
      detail: { blockingDimensions: payload.blockingDimensions ?? [] },
    });
    return {
      runId: run.id,
      status: "BLOCKED",
      recommendationId: null,
      quoteId: null,
      approvalCount: 1,
      termination: "NEEDS_INTERNAL_REVIEW",
      agentOutcome: outcome,
      groundingIssues: issues,
      toolSequence,
      turnCount: result.turnCount,
      toolCallCount: result.toolCallCount,
    };
  }

  // ── Quote draft — the deterministic finalizer takes over ────────────────
  const payload = result.terminalPayload as { candidateSkus: string[]; rationale: string };
  const candidateSources = await buildCandidateSources(prisma, payload.candidateSkus, incumbent);

  const finished = await finalizeCase(
    prisma,
    bus,
    provider,
    {
      runId: run.id,
      requestId,
      subject: request.subject,
      ownerId: request.ownerId,
      account,
      incumbent,
      requirements,
      quantity: quantity!,
      requiredBy: (await prisma.salesRequest.findUniqueOrThrow({ where: { id: requestId } })).requiredBy,
      destinationZone: account.siteZone ?? "MIDWEST",
      candidateSources,
      openQuestions: args.analysis.openQuestions,
      // Grounding has not run yet. Releasing here would put a quote in front
      // of a customer on the strength of a summary that is about to be
      // rejected, so the decision comes back to us below.
      deferAutoRelease: true,
      asOf: args.asOf,
    },
    args.startedAt,
  );

  // `Recommendation.productId` is a plain column, so the selected part is
  // read from the winning candidate rather than a relation.
  const recommendation = finished.recommendationId
    ? await prisma.recommendation.findUnique({
        where: { id: finished.recommendationId },
        include: {
          candidates: { include: { product: true, checks: true }, orderBy: { rank: "asc" } },
        },
      })
    : null;
  const winner = recommendation?.candidates.find((c) => c.verdict === "RECOMMENDED") ?? null;

  // Two different texts are in play here and they are not graded the same way.
  //
  // The model's own rationale is a claim and gets grounding-checked. The
  // recommendation rationale that `finalizeCase` produced is authoritative by
  // construction — it is assembled from engine output — so checking it against
  // the agent's investigation state would flag correct figures the agent never
  // had to look up itself.
  const outcome = buildOutcome(result, requestId, "READY_FOR_APPROVAL", {
    summary: recommendation?.rationale ?? payload.rationale,
    missingInformation: [],
    selected: winner?.product.sku ?? null,
    alternatives:
      recommendation?.candidates
        .filter((c) => c.verdict !== "RECOMMENDED")
        .slice(0, 12)
        .map((c) => ({ sku: c.product.sku, verdict: c.verdict, reason: c.reason.slice(0, 400) })) ?? [],
  });

  // The finalizer's own checks on the winning candidate, which supersede the
  // agent's earlier snapshot — it may have fitted an adapter the agent had not
  // seen when it ran its compatibility check.
  const quote = finished.quoteId
    ? await prisma.quote.findUnique({ where: { id: finished.quoteId }, include: { items: true } })
    : null;

  const authoritative: AuthoritativeVerdict | null = winner
    ? {
        sku: winner.product.sku,
        hardFailureDimensions: winner.checks
          .filter((c) => c.result === "FAIL" && c.severity === "HARD")
          .map((c) => c.dimension),
        // The finalizer's own money. The pricing tool never returns the quote
        // total — freight and rounding land after it — so without these the
        // most authoritative figure in the case reads as invented.
        figures: quote
          ? [
              quote.total.toString(),
              quote.subtotal.toString(),
              quote.freightCost.toString(),
              quote.discountTotal.toString(),
              ...quote.items.flatMap((i) => [i.unitPrice.toString(), i.extended.toString()]),
            ]
          : [],
      }
    : null;

  const issues = validate(
    { ...outcome, recommendationSummary: payload.rationale },
    result,
    args.catalog,
    authoritative,
  );
  await persistMeta(issues.length > 0 ? "NEEDS_INTERNAL_REVIEW" : "READY_FOR_APPROVAL", issues, outcome);

  // An ungrounded summary does not get quietly rewritten — the case is routed
  // to a person, because a recommendation nobody can trace is worth less than
  // none. The quote and approvals the finalizer produced still stand; they were
  // never the model's to make.
  //
  // This is also where the held-back release is decided. A clean run that was
  // inside every policy limit releases exactly as the deterministic pipeline
  // would; a run with an unsupported claim keeps the quote in draft.
  let status = finished.status;
  if (issues.length > 0) {
    await prisma.salesRequest.update({
      where: { id: requestId },
      data: {
        status: "NEEDS_REVIEW",
        risk: "HIGH",
        blockedReason: `The agent's summary contained ${issues.length} claim(s) no tool supported: ${issues[0]}`,
      },
    });
    status = "NEEDS_REVIEW";
  } else if (finished.autoReleaseEligible) {
    const { releaseQuote } = await import("@/lib/workflow");
    await releaseQuote(prisma, requestId, {
      actor: "Sales Engine",
      asOf: args.asOf,
      note: "Released without approval — every policy check was inside limits and the agent's summary was fully grounded.",
    });
    status = "RESPONSE_READY";
  }
  await finishRun(prisma, run.id, bus, args.startedAt, "COMPLETED");

  return {
    ...finished,
    status,
    termination: issues.length > 0 ? "NEEDS_INTERNAL_REVIEW" : "READY_FOR_APPROVAL",
    agentOutcome: outcome,
    groundingIssues: issues,
    toolSequence,
    turnCount: result.turnCount,
    toolCallCount: result.toolCallCount,
  };
}

function buildOutcome(
  result: AdaptiveResult,
  caseId: string,
  status: TerminationStatus,
  parts: {
    summary: string;
    missingInformation: string[];
    selected: string | null;
    alternatives?: { sku: string; verdict: string; reason: string }[];
    claims?: string[];
    evidence?: string[];
  },
): AgentOutcome {
  const blocked = result.state.compatibility.filter((c) => c.safety === "BLOCKED");
  const warned = result.state.compatibility.filter((c) => c.warnings.length > 0);

  const draft: AgentOutcome = {
    caseId,
    status,
    resolvedCustomer: result.state.customer?.name ?? null,
    resolvedProduct: parts.selected,
    alternatives:
      parts.alternatives ??
      blocked.slice(0, 12).map((c) => ({
        sku: c.sku,
        verdict: "REJECTED",
        reason: `Failed on ${c.hardFailures.map((f) => `${f.dimension} (${f.actual} against ${f.required})`).join("; ")}`,
      })),
    technicalEvidence: (parts.evidence ?? result.state.evidenceCited).slice(0, 20),
    claims: (parts.claims ?? []).slice(0, 10),
    missingInformation: parts.missingInformation.slice(0, 10),
    riskFlags: [
      ...warned.flatMap((c) => c.warnings.map((w) => `${c.sku}: ${w}`)),
      ...result.guardrailEvents.map((g) => `Guardrail: ${g.kind}`),
    ].slice(0, 10),
    recommendationSummary: parts.summary.slice(0, 2000),
  };

  const parsed = agentOutcomeSchema.safeParse(draft);
  if (parsed.success) return parsed.data;

  // Schema failure is our bug, not the model's — fall back to a minimal valid
  // outcome rather than persisting something that violates its own contract.
  return {
    caseId,
    status,
    resolvedCustomer: null,
    resolvedProduct: null,
    alternatives: [],
    technicalEvidence: [],
    missingInformation: [],
    claims: [],
    riskFlags: ["Structured outcome failed schema validation and was reduced."],
    recommendationSummary: parts.summary.slice(0, 2000) || "No summary was produced for this run.",
  };
}

function validate(
  outcome: AgentOutcome,
  result: AdaptiveResult,
  catalog: GroundingCatalog,
  authoritative: AuthoritativeVerdict | null = null,
): string[] {
  return checkGrounding(outcome, result.state, catalog, authoritative).map((i) => `${i.kind}: ${i.detail}`);
}

/**
 * Turn the agent's chosen part numbers into candidate sources.
 *
 * Curated replacement links are re-attached here rather than taken from the
 * agent, so an adapter requirement cannot be dropped by omission.
 */
async function buildCandidateSources(
  prisma: PrismaClient,
  skus: string[],
  incumbent: ProductView | null,
): Promise<SubstituteCandidate[]> {
  const rows = await prisma.product.findMany({
    where: { sku: { in: skus.map((s) => s.toUpperCase()) } },
    include: PRODUCT_INCLUDE,
  });
  const byId = new Map(rows.map((r) => [r.id, toProductView(r)]));

  const links = incumbent
    ? await prisma.substitutionLink.findMany({
        where: { fromProductId: incumbent.id, toProductId: { in: rows.map((r) => r.id) } },
        include: { toProduct: { include: PRODUCT_INCLUDE } },
      })
    : [];

  const adapterSkus = links.map((l) => l.requiresSku).filter((s): s is string => Boolean(s));
  const adapters = adapterSkus.length
    ? await prisma.product.findMany({ where: { sku: { in: adapterSkus } }, include: PRODUCT_INCLUDE })
    : [];

  const ordered = skus
    .map((sku) => rows.find((r) => r.sku === sku.toUpperCase()))
    .filter((r): r is NonNullable<typeof r> => Boolean(r));

  return ordered.map((row) => {
    const link = links.find((l) => l.toProductId === row.id);
    return {
      product: byId.get(row.id)!,
      linkKind: link?.kind ?? null,
      linkNote: link?.note ?? null,
      requiresSku: link?.requiresSku ?? null,
      adapter: link?.requiresSku
        ? (adapters.filter((a) => a.sku === link.requiresSku).map(toProductView)[0] ?? null)
        : null,
    };
  });
}

/**
 * The letter that goes in front of a person.
 *
 * Assembled here rather than asked of the model a second time: the answer has
 * already been grounding-checked, and re-generating the prose would put
 * ungraded text in the customer's letter.
 */
function composeInformationalLetter(
  account: { contactName: string | null },
  payload: { answer: string; evidenceRefs: string[]; uncertainty: string | null },
): string {
  const greeting = account.contactName ? `Hi ${account.contactName.split(" ")[0]},` : "Hello,";
  const parts = [greeting, "", payload.answer];
  if (payload.uncertainty) {
    parts.push("", `One thing worth flagging: ${payload.uncertainty}`);
  }
  parts.push(
    "",
    `This is based on ${payload.evidenceRefs.join(", ")}. If you would like a quotation for any of it, just say and I will put one together.`,
    "",
    "Best regards",
  );
  return parts.join("\n");
}

export { gapToQuestion };
export type { AgentOutcome };
