# Deployment

The public demo runs at **https://sales-engine.up.railway.app**.

---

## Architecture

**One long-running Next.js service and a managed PostgreSQL 16 database, in one Railway
project.** Nothing else: no queue, no cache, no separate MCP host.

```
visitor ──► sales-engine (next start, 1 replica, never sleeps) ──► Postgres (Railway, private network)
```

Why a long-running service rather than serverless:

| Property of this app | Consequence |
| --- | --- |
| A live adaptive run takes 15–130 s; the evaluation suite runs for over a minute | Serverless time limits would cut these off |
| Every page is `force-dynamic` and queries Postgres per request | A persistent connection pool suits it |
| The live-run rate limit (`ADAPTIVE_MAX_RUNS_PER_HOUR`) is in-memory | Exact with one long-lived instance |
| The MCP server is in-process over an in-memory transport | No extra service to host |

---

## Service configuration

Railway builds from `main` of `yds233013/sales-engine` with Railpack (Node from `.nvmrc`).
The settings live on the Railway service — Railway's `railway.json` config-as-code is deprecated —
and are these:

| Setting | Value |
| --- | --- |
| Install | `npm ci` (Railpack default; `postinstall` runs `prisma generate`) |
| Build command | `npm run build` |
| Pre-deploy command | `npm run db:release` → `prisma migrate deploy`, then seed **only if the database is empty** (`prisma/seed-if-empty.ts`) |
| Start command | `npm run start` (`next start`, binds to Railway's `PORT`) |
| Health check | `GET /api/health`, 120 s timeout |
| Restart policy | on failure, 5 retries |
| Replicas | 1 · serverless sleep off |
| Domain | `sales-engine.up.railway.app` |

A deploy that fails its health check never receives traffic; the previous deployment keeps serving.

### Schema

Production applies the committed migrations in `prisma/migrations/` with `prisma migrate deploy`.
It never runs `db push` or `migrate dev`. `0_init` is a baseline generated from
`prisma/schema.prisma`; applied to an empty database it produces exactly that schema (checked with
`prisma migrate diff --exit-code`).

Local development and the test suite still use `prisma db push` on throwaway databases. A schema
change needs a new migration: `npx prisma migrate dev --name <change>` against a local database,
then commit `prisma/migrations/`.

---

## Environment variables

| Variable | Production value | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (reference to the Railway database) | Prisma connection, private network |
| `AI_PROVIDER` | `mock` | Deterministic request extraction |
| `PUBLIC_DEMO` | `true` | Read-only public demo — see below |
| `NODE_ENV` | `production` | |
| `ANTHROPIC_API_KEY` | **not set** | Only needed for live adaptive runs |
| `ANTHROPIC_MODEL` | not set (defaults to `claude-sonnet-5`) | |
| `ALLOW_LIVE_ADAPTIVE` | not set | Would re-enable live runs on a public demo |
| `ADAPTIVE_MAX_RUNS_PER_HOUR` | not set | Per-process cap, only relevant with live runs on |
| `PORT` | set by Railway | |

`.env.example` documents each one. None reaches the browser: the client bundle is checked for the
connection string and key names after every deploy (see *Verification* below).

---

## The public-demo security model

The deployment shares one synthetic dataset between every visitor, and has no authentication.
`PUBLIC_DEMO=true` makes it read-only at the server.

**Allowed:** every screen — overview, inbox, every case including REQ-2041, approvals, catalog,
technical library and its citations, accounts, quotes, Agent Lab (architecture, captured live run,
adaptive paths, MCP toolbox), evaluations and adversarial results. The acting-user picker still
works, because it only changes what the page shows (it is stored in the browser). Running a
**seeded Agent Lab scenario in deterministic mode** is allowed: it runs the real engines on a
throwaway `EVAL-` copy, never the canonical case, costs nothing, and copies older than ten minutes
are deleted before each run.

**Refused, inside the server action** (`src/lib/demo-mode.ts`, used by `src/app/actions.ts` and
`src/app/agent-lab/actions.ts`):

| Action | Why |
| --- | --- |
| Decide an approval · release a quote · reprice · edit the customer response · close a case | Would change REQ-2041 or another shared case for every later visitor |
| Re-run analysis on a case · run a seeded case by reference in the Lab | Rewrites a canonical case's recommendation and trace |
| Create a custom Lab request | Adds a case other visitors would see |
| Run the evaluation suite | Over a minute of work per click; with a key, spends model credit |
| Any live adaptive run | Refused by `liveAdaptivePolicy`, enforced again inside `runAdaptiveRequest`; no key is configured in any case |

Because the refusal is in the action, calling an action endpoint directly gets the same answer
as clicking the (disabled) button. `tests/integration/public-demo.test.ts` does exactly that for
every action and asserts REQ-2041 is unchanged. The UI says why each control is disabled, and the
sidebar shows *Public demo · Read-only*.

The only routes are the pages and `GET /api/health`, which reports database reachability and
whether live runs are enabled — never a configuration value.

### Enabling live runs (not done on the public link)

Only behind authentication (platform basic auth or an identity proxy), with
`ALLOW_LIVE_ADAPTIVE=true`, `ADAPTIVE_MAX_RUNS_PER_HOUR` set, a single replica, and a monthly spend
limit on a dedicated Anthropic workspace. Note that `PUBLIC_DEMO=true` still refuses every other
write; unset it for a private, authenticated deployment.

---

## Demo data and resetting it

The seed is deterministic and synthetic: 77 products, 85 documents, 10 customers, 6 warehouses,
462 stock positions, 11 cases, and it runs the real analysis on each case, so REQ-2041 lands on
PX-440 × 12, $102,808.88, 30.38 % margin, three approvals pending.

**Primary protection is the read-only mode above**, not a reset: a visitor cannot change the
canonical data. No scheduled reseed is configured, on purpose — with writes refused, a nightly
destructive reseed would protect nothing and would take the site down for its duration and change
every case id each night. (Links by reference, such as `/cases/REQ-2041`, survive a reseed; links
by id do not.)

The Railway service id is `poka-sales-engine`, a name kept from before the project was renamed;
the commands below use it because they must match the deployed service. Renaming it would mean
recreating the service for no functional gain.

**Manual reset**, if it is ever needed. The database has no public endpoint, so the reset runs
inside the deploy pipeline and only the Railway project owner can trigger it. From a clone linked
to the project (`railway link`):

```bash
railway variable set DEMO_RESEED=true --service poka-sales-engine
```

Setting the variable redeploys; the pre-deploy step sees it and reseeds. When that deploy is live,
remove it so later deploys leave the data alone (this redeploys once more, without reseeding):

```bash
railway variable delete DEMO_RESEED --service poka-sales-engine
```

The seed wipes and rebuilds every table. Never run it with `DATABASE_URL` pointing at anything
but the demo database.

---

## Verification after a deploy

1. `GET /api/health` → `{"status":"ok","database":"ok",…,"liveAdaptive":"disabled"}`.
2. `/cases/REQ-2041` → PX-440 × 12, AX-220 rejected at 120 °C against ≥ 180 °C, PX-400 rejected on
   flow, 8 Dallas + 4 Houston, $102,808.88, 30.38 % margin, three approvals pending, release blocked.
3. Try an approval as a sales manager → refused with the read-only message; the case is unchanged.
4. Scan the served JavaScript for `postgres://`, `DATABASE_URL`, `ANTHROPIC_API_KEY`, `sk-ant-`.

---

## What is not production-ready

These are properties of a demo, stated so nobody mistakes them for oversights:

- **No authentication.** The acting-user picker lets anyone act as any role locally; the public
  demo is read-only for that reason.
- **Synthetic data only.** No integration with any real system.
- **Single tenant.** One shared dataset for every visitor.
