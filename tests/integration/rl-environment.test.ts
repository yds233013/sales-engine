import { afterAll, describe, expect, it } from "vitest";

import { db } from "../support/db";
import { SalesCaseEnv } from "@/lib/rl/environment";
import { rewardFor } from "@/lib/rl/reward";
import type { EvalResult } from "@/lib/eval/runner";

/**
 * The environment is only useful if a policy that is not our agent loop can
 * drive it and get a comparable number out. These episodes are driven by
 * hand — no model anywhere — which is the point: the world, the action space
 * and the verifier work on their own.
 */

afterAll(async () => {
  await db.$disconnect();
});

describe("sales case environment", () => {
  it("runs an episode and scores it, leaving the seeded case untouched", async () => {
    const before = await db.salesRequest.findFirstOrThrow({ where: { reference: "REQ-2041" } });
    const beforeRecommendations = await db.recommendation.count({ where: { requestId: before.id } });

    const env = new SalesCaseEnv(db);
    const start = await env.reset("hero-substitution");

    expect(start.request).toMatch(/AX-220/);
    expect(start.done).toBe(false);
    expect(start.stepsTaken).toBe(0);

    const tools = await env.actionSpace();
    expect(tools.map((t) => t.name)).toContain("check_compatibility");
    // The action space is the product's toolbox, not a wrapper around the
    // database: nothing here can approve or release.
    expect(tools.map((t) => t.name)).not.toContain("approve");

    const episodeCaseId = env.episodeRequestId;
    expect(episodeCaseId).toBeTruthy();

    const afterRead = await env.step({ tool: "get_request_state", input: {} });
    expect(afterRead.lastResult?.ok).toBe(true);
    expect(afterRead.state.requirementsLoaded).toBe(true);

    const afterCheck = await env.step({ tool: "check_compatibility", input: { sku: "AX-220" } });
    expect(afterCheck.lastResult?.ok).toBe(true);
    // State moved because a tool returned the finding, not because we said so.
    expect(afterCheck.state.compatibility.map((c) => c.sku)).toContain("AX-220");
    expect(afterCheck.stepsTaken).toBe(2);

    const episode = await env.finish();
    expect(episode.scenarioId).toBe("hero-substitution");
    expect(episode.steps).toBe(2);
    expect(episode.reward).toBeGreaterThanOrEqual(0);
    expect(episode.reward).toBeLessThanOrEqual(1);

    // Isolation: the seeded case is exactly as it was, and the episode's copy
    // is gone rather than left in the inbox.
    const after = await db.salesRequest.findFirstOrThrow({ where: { reference: "REQ-2041" } });
    expect(after.status).toBe(before.status);
    expect(await db.recommendation.count({ where: { requestId: before.id } })).toBe(beforeRecommendations);
    // The episode's own copy is gone rather than left behind in the inbox.
    expect(await db.salesRequest.count({ where: { id: episodeCaseId! } })).toBe(0);
  }, 60_000);

  it("gives a stopped-early episode less reward than a finished one", async () => {
    const env = new SalesCaseEnv(db);

    await env.reset("hero-substitution");
    await env.step({ tool: "get_request_state", input: {} });
    const lazy = await env.finish();

    // Nothing was concluded, so the verifier has nothing to credit.
    expect(lazy.reward).toBeLessThan(0.5);
    expect(lazy.terminalTool).toBeNull();
  }, 60_000);

  it("refuses an action outside the toolbox without ending the episode", async () => {
    const env = new SalesCaseEnv(db);
    await env.reset("hero-substitution");

    const refused = await env.step({ tool: "approve_everything", input: {} });
    expect(refused.lastResult?.ok).toBe(false);

    // The episode is still alive and still isolated.
    const next = await env.step({ tool: "get_request_state", input: {} });
    expect(next.state.requirementsLoaded).toBe(true);
    await env.close();
  }, 60_000);
});

describe("episode reward", () => {
  const base: EvalResult = {
    scenarioId: "x",
    title: "x",
    mode: "ADAPTIVE_AGENT",
    status: "PASS",
    notRunReason: null,
    expectedGapReason: null,
    outcome: "SUBSTITUTE",
    selectedSku: "PX-440",
    checks: [
      { name: "outcome", passed: true, detail: "", critical: false },
      { name: "selected-sku", passed: true, detail: "", critical: false },
      { name: "no-hard-failure-recommended", passed: true, detail: "", critical: true },
    ],
    metrics: {
      toolCalls: 10,
      modelInitiatedCalls: 10,
      unnecessaryCalls: 0,
      missingRequiredTools: [],
      repeatedCalls: 0,
      turnCount: 5,
      durationMs: 1000,
      inputTokens: null,
      outputTokens: null,
      groundingIssues: 0,
      safetyViolations: 0,
    },
    toolSequence: [],
    error: null,
  } as unknown as EvalResult;

  it("is 1 for a clean, correct, disciplined run", () => {
    expect(rewardFor(base).reward).toBe(1);
  });

  it("is 0 when a critical check fails, however good the rest looks", () => {
    const unsafe = {
      ...base,
      checks: base.checks.map((c) =>
        c.name === "no-hard-failure-recommended" ? { ...c, passed: false } : c,
      ),
    };
    const scored = rewardFor(unsafe);
    expect(scored.reward).toBe(0);
    expect(scored.safetyFailure).toBe("no-hard-failure-recommended");
  });

  it("separates a right answer with a thin record from a right answer with a full one", () => {
    const thin = {
      ...base,
      checks: [...base.checks, { name: "reject-AX-220", passed: false, detail: "", critical: false }],
    };
    const full = {
      ...base,
      checks: [...base.checks, { name: "reject-AX-220", passed: true, detail: "", critical: false }],
    };
    // The exact failure this project found in production: correct outcome,
    // weaker audit record. A pass/fail gate scores both as zero; the reward
    // has to tell them apart or it cannot measure the fix.
    expect(rewardFor(thin).reward).toBeLessThan(rewardFor(full).reward);
    expect(rewardFor(thin).reward).toBeGreaterThan(0.5);
  });

  it("docks a run that wandered", () => {
    const wandering = { ...base, metrics: { ...base.metrics, unnecessaryCalls: 2, repeatedCalls: 1 } };
    expect(rewardFor(wandering).reward).toBeLessThan(1);
    expect(rewardFor(wandering).reward).toBeGreaterThan(0.8);
  });
});
