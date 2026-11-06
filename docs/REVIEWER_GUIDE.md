# Reviewer guide

Two minutes, for someone opening this repository cold.

## Open first

1. **[The live demo, REQ-2041](https://sales-engine.up.railway.app/cases/REQ-2041).** One case
   shows the whole product. The public demo is read-only; locally every action works.
2. **[`src/lib/mcp/contracts.ts`](../src/lib/mcp/contracts.ts).** Every tool the agent has, with its
   schema and effect. What is *missing* matters as much: there is no tool that approves, releases,
   discounts or sends anything.
3. **`finalizeCase` in [`src/lib/agent/orchestrator.ts`](../src/lib/agent/orchestrator.ts).** Both
   execution modes end here. The model can influence which parts get examined, and nothing after
   that.

## What REQ-2041 demonstrates

The customer asks for 12 × AX-220 for a loop moving to 180 °C thermal fluid.

- **AX-220 fails a hard rule:** it is rated to 120 °C. PX-400 and PX-422 fail on flow. PX-460
  passes but is longer than the installed footprint, so it needs review. PX-440 is recommended.
- **Stock is split:** 8 from Dallas and 4 from Houston. No single site holds 12.
- **The quote** is $102,808.88 at a 30.38 % margin. Cost and margin never reach the customer draft.
- **Three approvals** block release: the substitution, the quote value and the split shipment. Each
  one belongs to a named role, and the server enforces that role.
- **Every value in the validation grid** links to the data-sheet section it was read from.

The deterministic pipeline and a live claude-sonnet-5 run both reach exactly this result. The
test suite asserts that they match.

## Where things live

| Concern | Path |
| --- | --- |
| Agent runtime (loop, budgets, termination) | [`src/lib/agent/adaptive/runtime.ts`](../src/lib/agent/adaptive/runtime.ts), guardrails in [`guardrails.ts`](../src/lib/agent/adaptive/guardrails.ts) |
| MCP server, client, contracts | [`src/lib/mcp/`](../src/lib/mcp) |
| Deterministic engines (pure, no Prisma) | [`src/lib/engines/`](../src/lib/engines): compatibility, inventory, pricing, freight, margin, approval, substitution |
| Grounding (a claim no tool returned is rejected) | `checkGrounding` in [`src/lib/agent/adaptive/outcome.ts`](../src/lib/agent/adaptive/outcome.ts) |
| Human transitions and the role gate | [`src/lib/workflow.ts`](../src/lib/workflow.ts) |
| Live-spend gate · public-demo write guard | [`src/lib/ai/capability.ts`](../src/lib/ai/capability.ts) · [`src/lib/demo-mode.ts`](../src/lib/demo-mode.ts) |
| Evals: scenarios, scoring, captured live results | [`src/lib/eval/`](../src/lib/eval) (`scenario.ts`, `runner.ts`, `captured.ts`) |
| Episode environment and scalar reward | [`src/lib/rl/`](../src/lib/rl) (`environment.ts`, `reward.ts`) · experiments in [`scripts/experiment.ts`](../scripts/experiment.ts) |
| Tests | [`tests/unit/`](../tests/unit) (276, no database) · [`tests/integration/`](../tests/integration) (135, real seeded Postgres) |

`npm run verify` runs typecheck, lint, both test suites and the production build.

## A known limitation worth inspecting

**One eval scenario fails intermittently, and it has been left failing.** Every live run got the
business outcome right (14 / 14), but only 13 / 14 passed the full evaluation. On refusal cases,
where nothing is compatible, the agent sometimes stops once it is satisfied nothing works. It then
records a reason against fewer candidates than the fixed pipeline does. Two runs on identical code
evaluated 19 candidates and 12. See the red row on the
[Evaluations page](https://sales-engine.up.railway.app/evaluations) and
[`docs/EVALS.md`](EVALS.md).

The adversarial results are also worth reading as written. In 3 of 4 attacks the model partly
complied in its prose, and grounding rejected the invented figures. The defence is that the model's
compliance changes nothing, not that the model resisted.
