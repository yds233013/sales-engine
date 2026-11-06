# Improving the agent

How a failure found in live runs became a fix that is measured and cannot come
back. One worked example, then the machinery that made it repeatable.

---

## 1. The failure

The evaluation suite reported 14/14 correct business outcomes but only 13/14
full passes. The failing row was `refusal-no-viable-option`: a customer wants
Hastelloy C-276 at 150 °C in a Zone 0 area, nothing in the catalog satisfies
all three, and the agent must refuse rather than offer a near-miss.

The agent reached the right answer every time. It failed on this check:

```
reject-AX-240: AX-240 was never evaluated.
```

AX-240 is the part the customer asked about. The engineer who picks up an
escalated case needs to see why it was ruled out; "never opened" and "opened
and rejected" look identical downstream. The same scenario had also produced a
19-call investigation on one run and a 12-call one on the next, on identical
code, so the behaviour was not even consistently wrong.

## 2. Root cause, not the symptom

Two defects, both in the harness rather than in the model's judgement.

**The escalation path recorded nothing it had examined.** `escalate_for_review`
created a recommendation row with no candidates at all — not even the parts the
run genuinely compatibility-checked. The evidence existed in the run's state and
was dropped on the way to the database, so the audit record was structurally
thinner than the deterministic pipeline's no matter how well the model behaved.

**Nothing required the requested part to be examined.** "Nothing in the catalog
meets this" is a claim about the catalog, and the agent could make it after
looking at whatever it liked, including nothing.

Prompt wording would have moved the failure rate around without removing either
cause. Both fixes are deterministic.

## 3. The fix

**A precondition on escalating** (`canEscalateForReview` in
`src/lib/agent/adaptive/state.ts`, enforced in `runtime.ts`), modelled on the
one that already guards informational answers. Escalation is refused, with an
actionable reason, unless:

- the part the customer named has been through `check_compatibility`, or has
  been established as not existing; and
- the catalog has been screened for alternatives at least once.

The requested part numbers come from the deterministic extractor's records, not
from the model's arguments, so the gate cannot be satisfied by naming a
different part. A screen that returns nothing still satisfies the second
condition — the agent is never trapped, only kept honest.

**Candidates are persisted on escalation** (`src/lib/agent/adaptive/index.ts`).
Every part the run compatibility-checked is written as a recommendation
candidate with its full check matrix, with verdicts re-derived from the
compatibility engine over stored specs rather than taken from the model's
account of them.

## 4. The measurement

Same scenario, three seeds each side, live against `claude-sonnet-5`:

```
  scenario                        n    pass            mean reward
  ──────────────────────────────────────────────────────────────────
  refusal-no-viable-option        3   0/3 → 3/3      0.750 → 1.000  ↑
  ──────────────────────────────────────────────────────────────────
  overall pass rate    0% → 100%
  difference           +0.250 ± 0.000 (95%)
  Welch p              n/a — zero variance in both groups
```

Reproduce it with the fix stashed and restored:

```bash
npm run experiment -- --label before --scenarios refusal-no-viable-option --seeds 3
npm run experiment -- --label after  --scenarios refusal-no-viable-option --seeds 3
npm run experiment -- --compare before after
```

Episodes are written to `evals/runs/*.jsonl` and committed, so the comparison is
re-derivable without anyone still having the terminal output.

**What this evidence is not.** Three episodes per side, one scenario, one model,
one day. Every episode within each group scored identically, which makes the
t statistic degenerate — the tool says so rather than printing a p value off a
division by zero. A categorical flip whose mechanism is understood is good
evidence that *this* failure is fixed; it is not evidence that the agent is
better in general. The regression tests below are what keep it fixed.

## 5. Keeping it fixed

Two integration tests in `tests/integration/adaptive.test.ts`:

- escalating before the requested part is examined is refused, the run recovers
  by doing the work, and the refusals are recorded as guardrail events;
- an escalated case records every part it examined, with the requested part
  carrying a hard failure rather than a bare verdict.

Both fail against the old code.

## 6. A second failure the same work exposed

`REQ-2035` began failing: the test expected PX-440 and got PX-422. Nothing had
changed in the engine. The seeded customer email said *"our shutdown window
opens Oct 12"* as a literal date, the extractor parsed it correctly, and once
that date passed every candidate missed the deadline, so deliverability ranking
legitimately chose a different pump.

The eval had not broken — the fixture had aged out from under it, silently, and
would have kept doing so. Dates written into customer prose are now generated
relative to the seed clock (`{{SHUTDOWN_DATE}}` in `prisma/seed/scenarios.ts`),
in the same format the message always used, so a scenario means the same thing
whenever it runs.

Worth stating plainly: this one was found by accident. Nothing in the suite
detects a scenario whose meaning drifts while its assertions still parse.

## 7. The environment underneath

`src/lib/rl/environment.ts` exposes the case machinery as a plain environment —
`reset()`, `step(action)`, `finish()` — so a policy that is not our agent loop
can be run against the same world and scored the same way.

- **Isolation.** Every episode runs on a throwaway copy of the case, so one
  episode cannot change what the next one sees. Analysing a seeded case
  rewrites its recommendation; without this, scenarios contaminate each other.
- **The action space is the MCP toolbox.** The same typed tools and effect
  classes the product's agent has. Nothing reachable here is unreachable there.
- **Reward comes from the verifier.** `src/lib/rl/reward.ts` folds the scorer's
  checks into one scalar in [0, 1]: correctness dominates, evidence and
  discipline make up the rest, and any check the scorer marks critical returns
  zero outright. A pass/fail gate scored "right answer, thin audit record" and
  "unsafe recommendation" identically at zero; the scalar is what made the fix
  above visible as 0.750 → 1.000 rather than a flat fail → pass.

Tests: `tests/integration/rl-environment.test.ts` drives episodes by hand, with
no model anywhere.

**No training happens in this repository.** No weights are updated, nothing
calls a fine-tuning API, and there is no rollout orchestration. This is the
environment and verifier half: enough to measure a policy, search over prompts
or harness settings, and produce scored trajectories — the piece a trainer
would plug into.

## 8. What I would do next

- **Widen before claiming general improvement.** Three seeds on one scenario
  justifies "this failure is fixed", nothing more. The suite needs seeds on
  every scenario before a change can be called an improvement to the agent.
- **Detect drifting fixtures.** The REQ-2035 rot was caught by luck. A check
  that fails when a scenario's parsed requirements change without its
  definition changing would have caught it the day it happened.
- **Find failures without a scenario for them.** Everything here measures known
  cases. Production failures arrive as unknown ones, which needs sampling and
  triage of real traces rather than a fixed suite.
