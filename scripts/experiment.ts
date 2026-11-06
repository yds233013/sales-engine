/**
 * Run an experiment, and compare two of them.
 *
 *   npm run experiment -- --label before --seeds 3
 *   npm run experiment -- --label after  --seeds 3 --scenarios refusal-no-viable-option
 *   npm run experiment -- --compare before after
 *
 * `npm run eval` answers "does the suite pass right now", which is a gate.
 * This answers a different question: "did that change make the agent better,
 * or did I get a good roll?" A live agent is stochastic — the same scenario
 * on identical code has produced a 19-call investigation and a 12-call one —
 * so a single run before and after a change is not evidence of anything.
 *
 * Each episode is written to evals/runs/<label>.jsonl with its scalar reward
 * and the checks behind it, so a comparison is re-derivable months later
 * without re-running anything or trusting a number in a commit message.
 *
 * The comparison reports an effect size with an interval and says plainly
 * when the data cannot distinguish the two. Small samples are the normal case
 * here — live runs cost money — so the output states n and refuses to dress
 * up three runs as a finding.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "../src/generated/prisma";
import { EVAL_SCENARIOS, scenarioById } from "../src/lib/eval/scenario";
import { runScenario, sweepOrphanedEvalCases, type EvalMode, type EvalResult } from "../src/lib/eval/runner";
import { rewardFor } from "../src/lib/rl/reward";

const RUN_DIR = join(process.cwd(), "evals", "runs");

interface Episode {
  label: string;
  scenarioId: string;
  seed: number;
  mode: EvalMode;
  status: EvalResult["status"];
  reward: number;
  safetyFailure: string | null;
  components: Record<string, number>;
  failedChecks: string[];
  metrics: { toolCalls: number; turnCount: number | null; durationMs: number; costUsd: number | null };
  ranAt: string;
}

function flag(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? (process.argv[i + 1] ?? null) : null;
}

// ── Statistics ──────────────────────────────────────────────────────────────
//
// Two small helpers rather than a dependency. Both are the standard textbook
// forms; what matters is that they are applied to the right thing and that
// their assumptions are stated where the result is printed.

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

/** Normal CDF, good to ~1e-7 — plenty for a two-sided p value we only bucket. */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (1.330274429 * t ** 4 - 1.821255978 * t ** 3 + 1.781477937 * t ** 2 - 0.356563782 * t + 0.319381530);
  return z > 0 ? 1 - p : p;
}

/**
 * Welch's t on the two reward samples, reported as a z-style p value.
 *
 * Welch rather than Student because the two groups have no reason to share a
 * variance: a fix that removes a failure mode usually removes spread as well
 * as raising the mean.
 */
function welch(a: number[], b: number[]): { diff: number; se: number; p: number } | null {
  if (a.length < 2 || b.length < 2) return null;
  const va = sd(a) ** 2 / a.length;
  const vb = sd(b) ** 2 / b.length;
  const se = Math.sqrt(va + vb);
  const diff = mean(b) - mean(a);
  if (se === 0) return { diff, se, p: diff === 0 ? 1 : 0 };
  return { diff, se, p: 2 * (1 - normalCdf(Math.abs(diff / se))) };
}

// ── Running ─────────────────────────────────────────────────────────────────

async function runExperiment(prisma: PrismaClient, label: string, seeds: number, scenarioIds: string[], mode: EvalMode) {
  const episodes: Episode[] = [];
  await sweepOrphanedEvalCases(prisma);

  for (const scenarioId of scenarioIds) {
    const scenario = scenarioById(scenarioId);
    if (!scenario) throw new Error(`Unknown scenario ${scenarioId}`);

    for (let seed = 1; seed <= seeds; seed++) {
      process.stdout.write(`  ${scenarioId} · seed ${seed}/${seeds} … `);
      const result = await runScenario(prisma, scenario, mode);
      const scored = rewardFor(result);
      episodes.push({
        label,
        scenarioId,
        seed,
        mode,
        status: result.status,
        reward: scored.reward,
        safetyFailure: scored.safetyFailure,
        components: scored.components,
        failedChecks: result.checks.filter((c) => !c.passed).map((c) => c.name),
        metrics: {
          toolCalls: result.metrics.toolCalls,
          turnCount: result.metrics.turnCount,
          durationMs: result.metrics.durationMs,
          costUsd: result.metrics.estimatedCostUsd ?? null,
        },
        ranAt: new Date().toISOString(),
      });
      process.stdout.write(`${result.status}  reward ${scored.reward.toFixed(3)}\n`);
    }
  }

  mkdirSync(RUN_DIR, { recursive: true });
  const path = join(RUN_DIR, `${label}.jsonl`);
  writeFileSync(path, episodes.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const rewards = episodes.map((e) => e.reward);
  const passRate = episodes.filter((e) => e.status === "PASS").length / episodes.length;
  console.log(`\n  ${episodes.length} episodes → ${path}`);
  console.log(`  pass rate     ${(passRate * 100).toFixed(0)}%`);
  console.log(`  mean reward   ${mean(rewards).toFixed(3)} (sd ${sd(rewards).toFixed(3)})`);
  return episodes;
}

function load(label: string): Episode[] {
  const path = join(RUN_DIR, `${label}.jsonl`);
  if (!existsSync(path)) throw new Error(`No run recorded at ${path}. Run --label ${label} first.`);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Episode);
}

function compare(aLabel: string, bLabel: string) {
  const a = load(aLabel);
  const b = load(bLabel);

  const scenarios = [...new Set([...a, ...b].map((e) => e.scenarioId))].sort();
  console.log(`\n  ${aLabel} → ${bLabel}\n`);
  console.log("  scenario                        n    pass            mean reward");
  console.log("  " + "─".repeat(70));

  for (const id of scenarios) {
    const ea = a.filter((e) => e.scenarioId === id);
    const eb = b.filter((e) => e.scenarioId === id);
    if (!ea.length || !eb.length) continue;
    const pa = ea.filter((e) => e.status === "PASS").length;
    const pb = eb.filter((e) => e.status === "PASS").length;
    const ra = mean(ea.map((e) => e.reward));
    const rb = mean(eb.map((e) => e.reward));
    const arrow = rb > ra ? "↑" : rb < ra ? "↓" : "=";
    console.log(
      `  ${id.padEnd(30)} ${String(ea.length).padStart(2)}   ` +
        `${pa}/${ea.length} → ${pb}/${eb.length}      ` +
        `${ra.toFixed(3)} → ${rb.toFixed(3)}  ${arrow}`,
    );
  }

  const ra = a.map((e) => e.reward);
  const rb = b.map((e) => e.reward);
  const test = welch(ra, rb);
  console.log("  " + "─".repeat(70));
  console.log(`  overall mean reward  ${mean(ra).toFixed(3)} → ${mean(rb).toFixed(3)}`);
  console.log(
    `  overall pass rate    ${((a.filter((e) => e.status === "PASS").length / a.length) * 100).toFixed(0)}%` +
      ` → ${((b.filter((e) => e.status === "PASS").length / b.length) * 100).toFixed(0)}%`,
  );

  if (!test) {
    console.log("\n  Too few episodes per group to say anything about noise. Run more seeds.");
    return;
  }

  const ci = 1.96 * test.se;
  console.log(`  difference           ${test.diff >= 0 ? "+" : ""}${test.diff.toFixed(3)} ± ${ci.toFixed(3)} (95%)`);

  // Every episode in both groups scoring identically makes the t statistic
  // divide by zero, and printing p < 0.001 off the back of that would be
  // false precision. A clean categorical flip is good evidence on its own;
  // it is just not evidence of the kind a p value describes.
  if (test.se === 0) {
    console.log(`  Welch p              n/a — zero variance in both groups`);
    console.log(
      `\n  Every episode scored the same within each group (n=${ra.length}/${rb.length}), so this is a` +
        ` categorical change rather than a statistical one. Treat it as real if the mechanism explains it,` +
        ` and widen the scenario set before claiming a general improvement.`,
    );
    return;
  }

  console.log(`  Welch p              ${test.p < 0.001 ? "<0.001" : test.p.toFixed(3)}`);

  // The honest reading, stated so nobody has to infer it from a p value.
  if (test.p >= 0.05) {
    console.log(
      `\n  Not distinguishable from noise at n=${ra.length}/${rb.length}.` +
        ` Either the change is small or there are too few episodes to see it.`,
    );
  } else if (test.diff > 0) {
    console.log(`\n  ${bLabel} scores higher, and ${ra.length}/${rb.length} episodes are enough to see it.`);
  } else {
    console.log(`\n  ${bLabel} scores lower. Treat as a regression until explained.`);
  }

  // A safety failure is never a matter of degree.
  const unsafe = b.filter((e) => e.safetyFailure);
  if (unsafe.length > 0) {
    console.log(`\n  ${unsafe.length} episode(s) in ${bLabel} failed a critical check:`);
    for (const e of unsafe) console.log(`    ${e.scenarioId} seed ${e.seed} — ${e.safetyFailure}`);
  }
}

async function main() {
  const comparePair = process.argv.indexOf("--compare");
  if (comparePair !== -1) {
    compare(process.argv[comparePair + 1], process.argv[comparePair + 2]);
    return;
  }

  const label = flag("label");
  if (!label) {
    console.error("Usage: npm run experiment -- --label <name> [--seeds 3] [--scenarios id,id] [--mode ADAPTIVE_AGENT]");
    process.exit(1);
  }
  const seeds = Number(flag("seeds") ?? 3);
  const mode = (flag("mode") ?? "ADAPTIVE_AGENT") as EvalMode;
  const scenarioIds = (flag("scenarios") ?? "").trim()
    ? flag("scenarios")!.split(",").map((s) => s.trim())
    : EVAL_SCENARIOS.map((s) => s.id);

  const prisma = new PrismaClient();
  console.log(`\n  experiment "${label}" · ${scenarioIds.length} scenario(s) × ${seeds} seed(s) · ${mode}\n`);
  try {
    await runExperiment(prisma, label, seeds, scenarioIds, mode);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
