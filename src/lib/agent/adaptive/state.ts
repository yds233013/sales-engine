/**
 * Investigation state.
 *
 * The agent does not reason out of its conversation history. Every fact it has
 * established lives here, written only by tool results, and every transition is
 * validated. That gives three things the transcript cannot:
 *
 *   - **Grounding.** A claim in the final output is checked against this state,
 *     and state entries only exist because a tool produced them.
 *   - **Loop detection.** Repeating a call that added nothing is visible.
 *   - **Truthful traces.** The operator-facing step list is derived from what
 *     actually landed in state, not from what the model said it did.
 */

import { z } from "zod";

export const TERMINATION_STATUSES = [
  "READY_FOR_APPROVAL",
  "INFORMATION_PROVIDED",
  "READY_TO_DRAFT",
  "NEEDS_CUSTOMER_CLARIFICATION",
  "NEEDS_INTERNAL_REVIEW",
  "BLOCKED_TECHNICAL",
  "GUARDRAIL_STOP",
  "FAILED",
] as const;
export type TerminationStatus = (typeof TERMINATION_STATUSES)[number];

export const compatibilityFindingSchema = z.object({
  sku: z.string(),
  safety: z.enum(["AUTO_SAFE", "NEEDS_REVIEW", "BLOCKED"]),
  hardFailures: z.array(z.object({ dimension: z.string(), required: z.string(), actual: z.string() })),
  warnings: z.array(z.string()),
  passCount: z.number(),
});

export const investigationStateSchema = z.object({
  requestId: z.string(),
  /** Set once resolve_customer has run. */
  customer: z
    .object({ name: z.string(), accountNumber: z.string(), site: z.string().nullable(), freightZone: z.string().nullable() })
    .nullable(),
  /** Requirements as extracted deterministically — never written by the model. */
  requirementsLoaded: z.boolean(),
  quantity: z.number().nullable(),
  /** Part numbers confirmed to exist in the catalog. */
  resolvedSkus: z.array(z.string()),
  /** Part numbers the customer named that do not exist. */
  unresolvedSkus: z.array(z.string()),
  /** Products seen via catalog search or substitute discovery. */
  candidatesConsidered: z.array(z.string()),
  /** How many times the catalog was screened for alternatives. */
  screensRun: z.number().default(0),
  compatibility: z.array(compatibilityFindingSchema),
  inventoryChecked: z.array(z.object({ sku: z.string(), totalAvailable: z.number() })),
  fulfillmentPlans: z.array(
    z.object({
      sku: z.string(),
      canFulfill: z.boolean(),
      isSplit: z.boolean(),
      meetsDeadline: z.boolean().nullable(),
      allocatedQty: z.number(),
    }),
  ),
  /**
   * Every money figure the pricing engine returned, not just the winner. An
   * outcome may legitimately mention the list price it discounted from or the
   * extended total, and grounding has to be able to recognise those.
   */
  pricesCalculated: z.array(
    z.object({
      sku: z.string(),
      unitPrice: z.string(),
      source: z.string(),
      listPrice: z.string(),
      extended: z.string(),
      considered: z.array(z.string()),
    }),
  ),
  /** Document sections retrieved, as `DS-1020 §2.1`. */
  evidenceCited: z.array(z.string()),
  openQuestions: z.array(z.string()),
});

export type InvestigationState = z.infer<typeof investigationStateSchema>;

export function emptyState(requestId: string): InvestigationState {
  return {
    requestId,
    customer: null,
    requirementsLoaded: false,
    quantity: null,
    resolvedSkus: [],
    unresolvedSkus: [],
    candidatesConsidered: [],
    screensRun: 0,
    compatibility: [],
    inventoryChecked: [],
    fulfillmentPlans: [],
    pricesCalculated: [],
    evidenceCited: [],
    openQuestions: [],
  };
}

const unique = (values: string[]) => [...new Set(values)];

/**
 * Fold a tool result into state.
 *
 * Deliberately total and boring: one switch, no inference, nothing derived
 * from model text. If a tool did not return a fact, the fact does not enter
 * state, and a claim about it will later fail grounding.
 */
export function applyToolResult(
  state: InvestigationState,
  toolName: string,
  output: unknown,
): InvestigationState {
  const next = { ...state };
  const data = (output ?? {}) as Record<string, never>;
  const read = <T>(key: string): T | undefined => (data as Record<string, unknown>)[key] as T | undefined;

  switch (toolName) {
    case "resolve_customer": {
      if (read<boolean>("found")) {
        next.customer = {
          name: read<string>("customerName") ?? "",
          accountNumber: read<string>("accountNumber") ?? "",
          site: read<string>("siteName") ?? null,
          freightZone: read<string>("freightZone") ?? null,
        };
      }
      break;
    }
    case "get_request_state": {
      next.requirementsLoaded = true;
      next.quantity = read<number | null>("quantity") ?? null;
      next.openQuestions = unique([...next.openQuestions, ...(read<string[]>("openQuestions") ?? [])]);
      break;
    }
    case "resolve_sku": {
      const sku = read<string | null>("sku");
      const requested = read<string>("requested");
      if (read<boolean>("found") && sku) {
        next.resolvedSkus = unique([...next.resolvedSkus, sku]);
      } else if (requested) {
        // A part number the catalog does not have is still a fact the agent
        // established with a tool, and it has to be able to say so: "PX-450
        // is not one of ours" is the whole answer to some requests.
        next.unresolvedSkus = unique([...next.unresolvedSkus, requested.toUpperCase()]);
      }
      break;
    }
    case "search_catalog": {
      const matches = read<{ sku: string }[]>("matches") ?? [];
      next.candidatesConsidered = unique([...next.candidatesConsidered, ...matches.map((m) => m.sku)]);
      next.screensRun += 1;
      break;
    }
    case "get_product": {
      const sku = read<string | null>("sku");
      if (sku) next.candidatesConsidered = unique([...next.candidatesConsidered, sku]);
      break;
    }
    case "find_substitutes": {
      const curated = read<{ sku: string }[]>("curated") ?? [];
      const screened = read<{ sku: string }[]>("screened") ?? [];
      next.candidatesConsidered = unique([
        ...next.candidatesConsidered,
        ...curated.map((c) => c.sku),
        ...screened.map((s) => s.sku),
      ]);
      next.screensRun += 1;
      break;
    }
    case "search_technical_docs": {
      const sections = read<{ documentNumber: string; anchor: string }[]>("sections") ?? [];
      next.evidenceCited = unique([
        ...next.evidenceCited,
        ...sections.map((s) => `${s.documentNumber} §${s.anchor}`),
      ]);
      break;
    }
    case "check_compatibility": {
      const sku = read<string>("sku");
      if (!sku) break;
      const checks =
        read<{ dimension: string; result: string; severity: string; required: string; actual: string; label: string }[]>(
          "checks",
        ) ?? [];
      const finding = {
        sku,
        safety: (read<string>("safety") ?? "NEEDS_REVIEW") as "AUTO_SAFE" | "NEEDS_REVIEW" | "BLOCKED",
        hardFailures: checks
          .filter((c) => c.result === "FAIL" && c.severity === "HARD")
          .map((c) => ({ dimension: c.dimension, required: c.required, actual: c.actual })),
        warnings: checks.filter((c) => c.result === "WARNING" || c.result === "UNKNOWN").map((c) => c.label),
        passCount: read<number>("passCount") ?? 0,
      };
      next.compatibility = [...next.compatibility.filter((c) => c.sku !== sku), finding];
      next.candidatesConsidered = unique([...next.candidatesConsidered, sku]);
      const evidence = read<{ documentNumber: string | null; anchor: string | null }[]>("evidence") ?? [];
      next.evidenceCited = unique([
        ...next.evidenceCited,
        ...evidence.filter((e) => e.documentNumber).map((e) => `${e.documentNumber} §${e.anchor}`),
      ]);
      break;
    }
    case "get_inventory": {
      const sku = read<string>("sku");
      if (!sku) break;
      next.inventoryChecked = [
        ...next.inventoryChecked.filter((i) => i.sku !== sku),
        { sku, totalAvailable: read<number>("totalAvailable") ?? 0 },
      ];
      break;
    }
    case "build_fulfillment_plan": {
      const sku = read<string>("sku");
      if (!sku) break;
      next.fulfillmentPlans = [
        ...next.fulfillmentPlans.filter((p) => p.sku !== sku),
        {
          sku,
          canFulfill: read<boolean>("canFulfill") ?? false,
          isSplit: read<boolean>("isSplit") ?? false,
          meetsDeadline: read<boolean | null>("meetsDeadline") ?? null,
          allocatedQty: Math.max(0, (read<number>("requestedQty") ?? 0) - (read<number>("shortfall") ?? 0)),
        },
      ];
      break;
    }
    case "calculate_price": {
      const sku = read<string>("sku");
      if (!sku) break;
      next.pricesCalculated = [
        ...next.pricesCalculated.filter((p) => p.sku !== sku),
        {
          sku,
          unitPrice: read<string>("unitPrice") ?? "",
          source: read<string>("priceSource") ?? "",
          listPrice: read<string>("listPrice") ?? "",
          extended: read<string>("extended") ?? "",
          considered: (read<{ unitPrice: string }[]>("considered") ?? []).map((c) => c.unitPrice),
        },
      ];
      break;
    }
    default:
      break;
  }

  return next;
}

/**
 * Preconditions for concluding with a quote draft.
 *
 * The deterministic finalizer will re-check everything anyway; this exists so
 * the agent gets a useful refusal *before* it burns a terminal action, and so
 * "concluded without ever checking compatibility" is impossible rather than
 * merely unlikely.
 */
export function canDraftQuote(
  state: InvestigationState,
  candidateSkus: string[],
): { ok: true } | { ok: false; reason: string } {
  if (!state.customer) {
    return { ok: false, reason: "The account has not been resolved. Call resolve_customer first." };
  }
  if (!state.requirementsLoaded) {
    return { ok: false, reason: "The case requirements have not been read. Call get_request_state first." };
  }
  if (state.quantity === null) {
    return {
      ok: false,
      reason: "No quantity was established for this request, so nothing can be quoted. Use request_clarification.",
    };
  }
  const unchecked = candidateSkus.filter((sku) => !state.compatibility.some((c) => c.sku === sku));
  if (unchecked.length > 0) {
    return {
      ok: false,
      reason: `Compatibility has not been checked for ${unchecked.join(", ")}. Every candidate must go through check_compatibility before it can be quoted.`,
    };
  }
  const blocked = candidateSkus.filter((sku) =>
    state.compatibility.some((c) => c.sku === sku && c.safety === "BLOCKED"),
  );
  if (blocked.length === candidateSkus.length) {
    // Naming the parts and the dimensions they failed on is what lets the
    // model recover — and it is what makes the refusal legible in the trace.
    const detail = blocked
      .map((sku) => {
        const finding = state.compatibility.find((c) => c.sku === sku);
        const dimensions = finding?.hardFailures.map((f) => f.dimension).join(", ");
        return dimensions ? `${sku} (${dimensions})` : sku;
      })
      .join("; ");
    return {
      ok: false,
      reason: `Every candidate failed a hard compatibility requirement — ${detail}. Nothing here can be quoted. Find another candidate, or use escalate_for_review.`,
    };
  }
  return { ok: true };
}

/**
 * Preconditions for answering an informational request.
 *
 * This is the gate that stops `respond_with_information` becoming a way to
 * assert anything the model likes. Its whole value is that an answer must be
 * assembled from things already established by tools in *this* run — so every
 * citation has to be one retrieval actually returned, and every part named has
 * to be one the catalog was actually asked about.
 *
 * Checked before the terminal action is spent, so a model that is close but
 * missing a lookup gets told what to go and fetch rather than losing the run.
 */
/**
 * Reduce a citation to the pair that identifies it.
 *
 * Live running showed the agent citing "DS-1026 §2.1 - Process limits" — the
 * right section with its heading attached — and being refused by an exact
 * string match that was listing "DS-1026 §2.1" as available in the same
 * breath. The document and anchor are what identify a section; a trailing
 * human-readable label is decoration. A citation that does not name both is
 * compared as written, so nothing becomes citable by being vague.
 */
function canonicalCitation(text: string): string {
  const match = /([A-Z]{2,4}-\d{2,5})\s*§\s*(\d+(?:\.\d+)*)/i.exec(text);
  return match ? `${match[1].toUpperCase()} §${match[2]}` : text.toUpperCase().replace(/\s+/g, " ").trim();
}

export function canRespondWithInformation(
  state: InvestigationState,
  input: { evidenceRefs: string[]; skus: string[] },
): { ok: true } | { ok: false; reason: string } {
  if (!state.requirementsLoaded) {
    return { ok: false, reason: "The case requirements have not been read. Call get_request_state first." };
  }
  if (input.evidenceRefs.length === 0) {
    return {
      ok: false,
      reason:
        "An informational answer must cite the evidence it rests on. Retrieve the relevant section with search_technical_docs or check_compatibility first.",
    };
  }

  const retrieved = new Set(state.evidenceCited.map(canonicalCitation));
  const unknown = input.evidenceRefs.filter((ref) => !retrieved.has(canonicalCitation(ref)));
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: `No tool in this run returned ${unknown.join(", ")}. Cite only sections retrieval actually produced${
        state.evidenceCited.length ? ` — you have ${state.evidenceCited.join(", ")}` : ", and you have none yet"
      }.`,
    };
  }

  // A part number in the answer must be one this run looked at, whether it was
  // found, ruled out, or established as missing.
  const known = new Set([
    ...state.resolvedSkus,
    ...state.unresolvedSkus,
    ...state.candidatesConsidered,
    ...state.compatibility.map((c) => c.sku),
  ].map((s) => s.toUpperCase()));
  const unchecked = input.skus.filter((sku) => !known.has(sku.toUpperCase()));
  if (unchecked.length > 0) {
    return {
      ok: false,
      reason: `${unchecked.join(", ")} was never looked up in this run. Call resolve_sku or check_compatibility before answering about it.`,
    };
  }

  return { ok: true };
}

/**
 * Whether this run has earned the right to escalate.
 *
 * "Nothing in the catalog meets this" is a claim about the catalog, and an
 * escalation that skips the part the customer actually named leaves the
 * weakest possible audit record: an engineer picks the case up and cannot see
 * whether the requested part was ruled out or merely never opened. Live runs
 * did exactly that — concluding correctly, on fewer candidates than the fixed
 * pipeline records, and differently from one run to the next.
 *
 * So the gate asks for the two things that make the conclusion checkable: the
 * requested part went through compatibility, and the catalog was screened for
 * alternatives at least once. Both are satisfiable with one tool call each,
 * and a screen that returns nothing still satisfies the second — the agent is
 * never trapped, only kept honest.
 */
export function canEscalateForReview(
  state: InvestigationState,
  input: { requestedSkus: string[] },
): { ok: true } | { ok: false; reason: string } {
  if (!state.requirementsLoaded) {
    return { ok: false, reason: "The case requirements have not been read. Call get_request_state first." };
  }

  const checked = new Set(state.compatibility.map((c) => c.sku.toUpperCase()));
  // A part that does not exist cannot be checked, and saying so is a result.
  const missing = new Set(state.unresolvedSkus.map((s) => s.toUpperCase()));
  const unexamined = input.requestedSkus.filter(
    (sku) => !checked.has(sku.toUpperCase()) && !missing.has(sku.toUpperCase()),
  );
  if (unexamined.length > 0) {
    return {
      ok: false,
      reason: `${unexamined.join(", ")} is the part the customer asked about and it has not been through check_compatibility in this run. Check it before concluding the requirement cannot be met — the engineer picking this up needs to see why it was ruled out.`,
    };
  }

  if (state.screensRun === 0) {
    return {
      ok: false,
      reason:
        "No alternative has been looked for yet. Run find_substitutes or search_catalog before concluding nothing in the catalog fits; an empty result is a legitimate answer, not looking is not.",
    };
  }

  return { ok: true };
}

/**
 * The operator-facing step list.
 *
 * Built from state, so it can only describe work that actually happened.
 */
export function narrateState(state: InvestigationState): string[] {
  const steps: string[] = [];
  if (state.customer) steps.push(`Resolved ${state.customer.name}${state.customer.site ? ` — ${state.customer.site}` : ""}`);
  if (state.requirementsLoaded) {
    steps.push(`Read the extracted requirements${state.quantity ? ` (${state.quantity} units)` : ""}`);
  }
  if (state.resolvedSkus.length > 0) steps.push(`Confirmed part number(s) ${state.resolvedSkus.join(", ")}`);
  if (state.unresolvedSkus.length > 0) steps.push(`Could not resolve ${state.unresolvedSkus.join(", ")}`);
  if (state.candidatesConsidered.length > 0) {
    steps.push(`Considered ${state.candidatesConsidered.length} candidate product(s)`);
  }
  if (state.evidenceCited.length > 0) steps.push(`Retrieved ${state.evidenceCited.length} document section(s)`);
  for (const finding of state.compatibility) {
    steps.push(
      finding.safety === "BLOCKED"
        ? `Eliminated ${finding.sku} — ${finding.hardFailures.map((f) => f.dimension).join(", ")}`
        : `Validated ${finding.sku} (${finding.passCount} checks pass${finding.warnings.length ? `, ${finding.warnings.length} warning(s)` : ""})`,
    );
  }
  for (const plan of state.fulfillmentPlans) {
    steps.push(
      plan.canFulfill
        ? `Planned fulfillment for ${plan.sku}${plan.isSplit ? " across multiple locations" : ""}`
        : `${plan.sku} cannot cover the requested quantity`,
    );
  }
  for (const price of state.pricesCalculated) steps.push(`Priced ${price.sku} via ${price.source.toLowerCase()}`);
  return steps;
}
