import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "../support/db";
import { runAdaptiveRequest, AdaptiveUnavailableError } from "@/lib/agent/adaptive";
import { FakeModelClient, substitutionScript, type ScriptedTurn } from "../support/fake-model";
import { CaseTracker } from "../support/cases";

/**
 * The adaptive runtime driven by a scripted model.
 *
 * Only the model is a double. MCP, the engines, the guardrails, grounding and
 * the deterministic finalizer are all the real implementations, so these tests
 * exercise the safety boundary rather than a mock of it.
 */

const MODEL = "claude-sonnet-5";
const cases = new CaseTracker(db);

/**
 * A copy of a seeded case. Never the seeded case itself — running one rewrites
 * its quote and approvals, and the scenario suite asserts against those.
 */
const caseId = (reference: string) => cases.clone(reference);

const ephemeralCase = (subject: string, body: string, accountNumber = "ACC-10044") =>
  cases.create("ADP", subject, body, accountNumber);

function run(requestId: string, script: ScriptedTurn[], options: { failOnTurn?: number } = {}) {
  return runAdaptiveRequest(db, requestId, {
    modelClient: new FakeModelClient(script, options),
    model: MODEL,
  });
}

afterEach(async () => {
  await cases.cleanup();
});

afterAll(async () => {
  await cases.cleanup();
  await db.$disconnect();
});

describe("adaptive investigation", () => {
  it("reaches the same commercial result as the deterministic pipeline on REQ-2041", async () => {
    const id = await caseId("REQ-2041");
    const result = await run(id, substitutionScript("AX-220", "PX-440"));

    expect(result.termination).toBe("READY_FOR_APPROVAL");
    expect(result.groundingIssues).toHaveLength(0);

    const quote = await db.quote.findFirstOrThrow({
      where: { requestId: id },
      include: { items: { include: { product: true } } },
    });
    // The numbers are the finalizer's, not the agent's, so they match the
    // deterministic run exactly.
    expect(quote.items[0].product.sku).toBe("PX-440");
    expect(quote.items[0].quantity).toBe(12);
    expect(Number(quote.total)).toBeCloseTo(102808.88, 2);
    expect(Number(quote.marginPct)).toBeCloseTo(30.38, 1);
    expect(result.approvalCount).toBe(3);
    expect(quote.status).toBe("PENDING_APPROVAL");
  });

  it("marks a scripted run as scripted, never as live", async () => {
    // The UI reads this to label a run. A scripted test and a live call both
    // record ADAPTIVE_AGENT with a model name, so without this discriminator
    // a fixture would be presented as a real agent result.
    const id = await caseId("REQ-2041");
    const result = await run(id, substitutionScript("AX-220", "PX-440"));
    const persisted = await db.agentRun.findUniqueOrThrow({ where: { id: result.runId } });
    expect(persisted.modelSource).toBe("SCRIPTED");
    expect(persisted.mode).toBe("ADAPTIVE_AGENT");
  });

  it("leaves a deterministic run with no model source at all", async () => {
    const { runSalesRequest } = await import("@/lib/agent/orchestrator");
    const id = await caseId("REQ-2041");
    const outcome = await runSalesRequest(db, id);
    const persisted = await db.agentRun.findUniqueOrThrow({ where: { id: outcome.runId } });
    expect(persisted.modelSource).toBe("NONE");
    expect(persisted.model).toBeNull();
  });

  it("records the run as adaptive with real observability", async () => {
    const id = await caseId("REQ-2041");
    const result = await run(id, substitutionScript("AX-220", "PX-440"));
    const agentRun = await db.agentRun.findUniqueOrThrow({ where: { id: result.runId } });

    expect(agentRun.mode).toBe("ADAPTIVE_AGENT");
    expect(agentRun.model).toBe(MODEL);
    expect(agentRun.turnCount).toBeGreaterThan(0);
    expect(agentRun.toolCallCount).toBeGreaterThan(0);
    expect(agentRun.inputTokens).toBeGreaterThan(0);
    expect(Number(agentRun.estimatedCostUsd)).toBeGreaterThan(0);
    expect(agentRun.termination).toBe("READY_FOR_APPROVAL");
  });

  it("produces a trace whose every step corresponds to a real executed call", async () => {
    const id = await caseId("REQ-2041");
    const result = await run(id, substitutionScript("AX-220", "PX-440"));
    const calls = await db.toolCall.findMany({ where: { runId: result.runId }, orderBy: { sequence: "asc" } });

    const modelCalls = calls.filter((c) => c.modelInitiated).map((c) => c.toolName);
    // Exactly the tools the script asked for, in order, plus the fan-out that
    // find_substitutes performs internally.
    expect(modelCalls).toContain("resolve_customer");
    expect(modelCalls).toContain("check_compatibility");
    expect(modelCalls).toContain("create_quote_draft");
    expect(calls.some((c) => !c.modelInitiated)).toBe(true);
    for (const call of calls) {
      expect(call.summary.length).toBeGreaterThan(10);
      expect(call.durationMs).toBeGreaterThan(0);
    }
  });

  it("takes a different tool path for a question that needs no commercials", async () => {
    const id = await ephemeralCase(
      "Quick question on the MX-160",
      "Can the MX-160 handle 175 C? Not asking for a quote yet.",
      "ACC-10102",
    );
    const result = await run(id, [
      { calls: [{ name: "get_request_state", input: {} }] },
      { calls: [{ name: "check_compatibility", input: { sku: "MX-160" } }] },
      {
        calls: [
          {
            name: "request_clarification",
            input: {
              questions: ["Can you confirm the duty is a permanent change rather than an excursion?"],
              reason:
                "The MX-160 is rated below the stated 175 C, so it cannot be used for that duty. Confirming the intent before proposing a different part.",
            },
          },
        ],
      },
    ]);

    expect(result.termination).toBe("NEEDS_CUSTOMER_CLARIFICATION");
    const calls = await db.toolCall.findMany({ where: { runId: result.runId } });
    const names = calls.filter((c) => c.modelInitiated).map((c) => c.toolName);
    // The point of the mode: it did not run pricing, freight or margin.
    expect(names).not.toContain("calculate_price");
    expect(names).not.toContain("calculate_freight");
    expect(names).not.toContain("check_margin");
    expect(await db.quote.count({ where: { requestId: id } })).toBe(0);
  });

  it("escalates instead of recommending when everything is blocked", async () => {
    const id = await caseId("REQ-2026");
    const result = await run(id, [
      { calls: [{ name: "get_request_state", input: {} }] },
      { calls: [{ name: "check_compatibility", input: { sku: "AX-240" } }] },
      { calls: [{ name: "find_substitutes", input: { sku: "AX-240" } }] },
      { calls: [{ name: "check_compatibility", input: { sku: "MX-200" } }] },
      {
        calls: [
          {
            name: "escalate_for_review",
            input: {
              reason:
                "The duty requires Hastelloy C-276 at 150 C in a Zone 0 area. Nothing in the catalog satisfies all three, so this needs application engineering rather than a catalog selection.",
              blockingDimensions: ["material", "hazardous_area", "temperature"],
            },
          },
        ],
      },
    ]);

    expect(result.termination).toBe("NEEDS_INTERNAL_REVIEW");
    expect(result.status).toBe("BLOCKED");
    expect(await db.quote.count({ where: { requestId: id } })).toBe(0);
  });
});

describe("agent mutation safety", () => {
  it("cannot approve an approval it caused to be raised", async () => {
    const id = await caseId("REQ-2041");
    const result = await run(id, substitutionScript("AX-220", "PX-440"));
    const approvals = await db.approval.findMany({ where: { requestId: id } });

    expect(approvals.length).toBeGreaterThan(0);
    for (const approval of approvals) {
      expect(approval.status).toBe("PENDING");
      expect(approval.decidedById).toBeNull();
      expect(approval.decidedAt).toBeNull();
    }
    expect(result.status).not.toBe("APPROVED");
  });

  it("cannot release the quote it drafted", async () => {
    const id = await caseId("REQ-2041");
    await run(id, substitutionScript("AX-220", "PX-440"));
    const quote = await db.quote.findFirstOrThrow({ where: { requestId: id } });
    expect(quote.status).toBe("PENDING_APPROVAL");
    // And nothing customer-facing exists while approvals are open.
    expect(await db.customerResponse.count({ where: { requestId: id } })).toBe(0);
  });

  it("cannot quote a product that failed a hard compatibility requirement", async () => {
    const id = await caseId("REQ-2041");
    // The script insists on the part that fails on temperature.
    const result = await run(id, [
      { calls: [{ name: "resolve_customer", input: {} }] },
      { calls: [{ name: "get_request_state", input: {} }] },
      { calls: [{ name: "check_compatibility", input: { sku: "AX-220" } }] },
      {
        calls: [
          {
            name: "create_quote_draft",
            input: {
              candidateSkus: ["AX-220"],
              rationale: "The customer asked for the AX-220 and has run it for years, so quote it as requested.",
            },
          },
        ],
      },
      { calls: [{ name: "check_compatibility", input: { sku: "PX-440" } }] },
      {
        calls: [
          {
            name: "create_quote_draft",
            input: {
              candidateSkus: ["AX-220", "PX-440"],
              rationale: "AX-220 fails on temperature for this duty, so PX-440 is proposed in its place.",
            },
          },
        ],
      },
    ]);

    // The refusal is asserted directly rather than inferred from the end
    // state: the run must record *why* the first draft was rejected.
    const run1 = await db.agentRun.findUniqueOrThrow({ where: { id: result.runId } });
    const events = (run1.guardrailEvents ?? []) as { kind: string; detail: string }[];
    expect(
      events.some((e) => e.kind === "FORBIDDEN_EFFECT" && /AX-220/.test(e.detail) && /hard/i.test(e.detail)),
    ).toBe(true);

    // The run only concluded once a viable candidate was included, and the
    // quoted part is the viable one. `findFirstOrThrow` so a missing quote
    // fails as a missing quote rather than as a TypeError three lines later.
    const quote = await db.quote.findFirstOrThrow({
      where: { requestId: id },
      include: { items: { include: { product: true } } },
    });
    expect(quote.items.map((i) => i.product.sku)).toContain("PX-440");
    expect(quote.items.map((i) => i.product.sku)).not.toContain("AX-220");
    expect(result.termination).toBe("READY_FOR_APPROVAL");
  });

  it("cannot change a price the pricing engine computed", async () => {
    const id = await caseId("REQ-2041");
    await run(id, substitutionScript("AX-220", "PX-440"));
    const quote = await db.quote.findFirstOrThrow({
      where: { requestId: id },
      include: { items: true },
    });
    const line = quote.items[0];
    // Price comes from the price book, not from anything the agent said.
    expect(line.priceSource).toBe("PRICE_BOOK");
    expect(Number(line.unitPrice) * line.quantity).toBeCloseTo(Number(line.extended), 2);
  });
});

describe("guardrails in the loop", () => {
  it("stops at the turn limit when the model never concludes", async () => {
    const id = await ephemeralCase("Endless", "Please quote 5 x MX-160 for the Charlotte plant at 90 C.");
    const result = await runAdaptiveRequest(db, id, {
      modelClient: new FakeModelClient([{ calls: [{ name: "get_request_state", input: {} }] }]),
      model: MODEL,
      guardrails: { maxTurns: 4 },
    });
    expect(result.termination).toBe("GUARDRAIL_STOP");
    expect(result.status).toBe("NEEDS_REVIEW");
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: result.runId } });
    const events = run.guardrailEvents as { kind: string }[];
    expect(events.some((e) => e.kind === "TURN_LIMIT")).toBe(true);
  });

  it("stops at the tool-call limit", async () => {
    const id = await ephemeralCase("Busy", "Please quote 5 x MX-160 for the Charlotte plant at 90 C.");
    const script = Array.from({ length: 12 }, (_, i) => ({
      calls: [{ name: "get_product", input: { sku: i % 2 === 0 ? "PX-440" : "MX-160" } }],
    }));
    const result = await runAdaptiveRequest(db, id, {
      modelClient: new FakeModelClient(script),
      model: MODEL,
      guardrails: { maxToolCalls: 5, maxTurns: 30 },
    });
    expect(result.termination).toBe("GUARDRAIL_STOP");
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: result.runId } });
    expect((run.guardrailEvents as { kind: string }[]).some((e) => e.kind === "TOOL_LIMIT")).toBe(true);
  });

  it("refuses a looping call and tells the model why", async () => {
    const id = await ephemeralCase("Loop", "Please quote 5 x MX-160 for the Charlotte plant at 90 C.");
    const script = Array.from({ length: 8 }, () => ({
      calls: [{ name: "get_inventory", input: { sku: "MX-160" } }],
    }));
    const result = await runAdaptiveRequest(db, id, {
      modelClient: new FakeModelClient(script),
      model: MODEL,
      guardrails: { maxIdenticalCalls: 2, maxTurns: 10 },
    });
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: result.runId } });
    expect((run.guardrailEvents as { kind: string }[]).some((e) => e.kind === "REPEATED_CALL")).toBe(true);
  });

  it("survives a provider outage without corrupting the case", async () => {
    const id = await ephemeralCase("Outage", "Please quote 5 x MX-160 for the Charlotte plant at 90 C.");
    const result = await runAdaptiveRequest(db, id, {
      modelClient: new FakeModelClient([], { failOnTurn: 0, failWith: new Error("503 upstream unavailable") }),
      model: MODEL,
    });
    expect(result.termination).toBe("FAILED");
    expect(result.status).toBe("NEEDS_REVIEW");
    const request = await db.salesRequest.findUniqueOrThrow({ where: { id } });
    // A provider outage is an outage, not a safety verdict.
    expect(request.status).toBe("NEEDS_REVIEW");
    expect(request.blockedReason).toMatch(/deterministic workflow/i);
    expect(await db.quote.count({ where: { requestId: id } })).toBe(0);
  });

  /**
   * Live runs concluded "nothing in the catalog fits" without ever opening the
   * part the customer asked about, which left an engineer unable to tell a
   * rejected part from an unexamined one. The gate refuses that escalation and
   * says what is missing; the run recovers by doing the work.
   */
  it("refuses to escalate before the requested part has been examined, then accepts it", async () => {
    const id = await caseId("REQ-2026");
    const result = await run(id, [
      { calls: [{ name: "get_request_state", input: {} }] },
      {
        calls: [
          {
            name: "escalate_for_review",
            input: { reason: "Nothing here will work.", blockingDimensions: ["material"] },
          },
        ],
      },
      { calls: [{ name: "check_compatibility", input: { sku: "AX-240" } }] },
      {
        calls: [
          {
            name: "escalate_for_review",
            input: { reason: "Still nothing.", blockingDimensions: ["material"] },
          },
        ],
      },
      { calls: [{ name: "find_substitutes", input: { sku: "AX-240" } }] },
      {
        calls: [
          {
            name: "escalate_for_review",
            input: {
              reason: "Hastelloy C-276 at 150 C in Zone 0 is not met by any catalog product.",
              blockingDimensions: ["material", "hazardous_area"],
            },
          },
        ],
      },
    ]);

    expect(result.termination).toBe("NEEDS_INTERNAL_REVIEW");

    const run_ = await db.agentRun.findUniqueOrThrow({ where: { id: result.runId } });
    const events = run_.guardrailEvents as { kind: string; detail?: string }[];
    const refusals = events.filter((e) => e.kind === "FORBIDDEN_EFFECT");
    expect(refusals.length).toBe(2);
    expect(refusals[0].detail ?? "").toMatch(/check_compatibility/i);
    expect(refusals[1].detail ?? "").toMatch(/find_substitutes|search_catalog/i);
  });

  /**
   * The other half of the same failure: the escalation used to persist a
   * recommendation with no candidates at all, so the work the run really did
   * was invisible downstream and the eval scored it as thinner than it was.
   */
  it("records every part it examined when it escalates", async () => {
    const id = await caseId("REQ-2026");
    const result = await run(id, [
      { calls: [{ name: "get_request_state", input: {} }] },
      { calls: [{ name: "check_compatibility", input: { sku: "AX-240" } }] },
      { calls: [{ name: "find_substitutes", input: { sku: "AX-240" } }] },
      { calls: [{ name: "check_compatibility", input: { sku: "MX-200" } }] },
      {
        calls: [
          {
            name: "escalate_for_review",
            input: {
              reason: "No catalog product satisfies Hastelloy C-276 at 150 C in Zone 0.",
              blockingDimensions: ["material", "hazardous_area"],
            },
          },
        ],
      },
    ]);

    expect(result.termination).toBe("NEEDS_INTERNAL_REVIEW");

    const recommendation = await db.recommendation.findFirstOrThrow({
      where: { requestId: id },
      orderBy: { createdAt: "desc" },
      include: { candidates: { include: { checks: true, product: true } } },
    });
    const skus = recommendation.candidates.map((c) => c.product.sku);
    expect(skus).toContain("AX-240");
    expect(skus).toContain("MX-200");

    // The requested part carries a recorded reason, not just a verdict.
    const requested = recommendation.candidates.find((c) => c.product.sku === "AX-240")!;
    expect(requested.verdict).toBe("REJECTED");
    expect(requested.checks.some((k) => k.result === "FAIL" && k.severity === "HARD")).toBe(true);
  });

  it("handles a model that invents a tool name", async () => {
    const id = await ephemeralCase("Invented", "Please quote 5 x MX-160 for the Charlotte plant at 90 C.");
    const result = await runAdaptiveRequest(db, id, {
      modelClient: new FakeModelClient([
        { calls: [{ name: "approve_everything", input: {} }] },
        { calls: [{ name: "get_request_state", input: {} }] },
        { calls: [{ name: "check_compatibility", input: { sku: "MX-160" } }] },
        { calls: [{ name: "find_substitutes", input: { sku: "MX-160" } }] },
        {
          calls: [
            {
              name: "escalate_for_review",
              input: { reason: "Could not complete the investigation within the available tools and evidence." },
            },
          ],
        },
      ]),
      model: MODEL,
      guardrails: { maxTurns: 10 },
    });
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: result.runId } });
    expect((run.guardrailEvents as { kind: string }[]).some((e) => e.kind === "UNKNOWN_TOOL")).toBe(true);
    expect(result.termination).toBe("NEEDS_INTERNAL_REVIEW");
  });

  it("abandons the run after repeated invalid arguments", async () => {
    const id = await ephemeralCase("Invalid", "Please quote 5 x MX-160 for the Charlotte plant at 90 C.");
    const result = await runAdaptiveRequest(db, id, {
      modelClient: new FakeModelClient(
        // Distinct part numbers, so loop detection does not intercept these
        // before the invalid-argument counter can trip.
        Array.from({ length: 6 }, (_, i) => ({
          calls: [{ name: "get_inventory", input: { sku: `NOPE-00${i}` } }],
        })),
      ),
      model: MODEL,
      guardrails: { maxConsecutiveInvalid: 3, maxTurns: 10 },
    });
    expect(result.termination).toBe("GUARDRAIL_STOP");
    const run = await db.agentRun.findUniqueOrThrow({ where: { id: result.runId } });
    expect(run.errorCategory).toBe("REPEATED_INVALID_ARGS");
  });
});

describe("availability", () => {
  it("refuses to run adaptively with no provider configured", async () => {
    const id = await caseId("REQ-2041");
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(runAdaptiveRequest(db, id)).rejects.toThrow(AdaptiveUnavailableError);
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});

describe("public demo spend gate", () => {
  it("refuses a live run on a public demo even when called directly", async () => {
    const saved = { ...process.env };
    try {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test";
      process.env.PUBLIC_DEMO = "true";
      delete process.env.ALLOW_LIVE_ADAPTIVE;
      const id = await ephemeralCase("Gate", "Please quote 5 x MX-160 for the Charlotte plant at 90 C.");
      // No modelClient: this is the path that would bill a provider.
      await expect(runAdaptiveRequest(db, id, { model: MODEL })).rejects.toThrow(/public demo/i);
      // Nothing was started — no run row, nothing to clean up.
      expect(await db.agentRun.count({ where: { requestId: id } })).toBe(0);
    } finally {
      process.env = saved;
    }
  });

  it("still allows a scripted run, which bills nothing", async () => {
    const saved = { ...process.env };
    try {
      process.env.PUBLIC_DEMO = "true";
      const id = await ephemeralCase("Scripted", "Please quote 5 x MX-160 for the Charlotte plant at 90 C.");
      const result = await run(id, [{ calls: [{ name: "get_request_state", input: {} }] }]);
      expect(result.runId).toBeTruthy();
    } finally {
      process.env = saved;
    }
  });
});
