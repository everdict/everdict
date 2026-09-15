---
kind: wiki
title: "Control-plane API (@everdict/api)"
status: current
updated: 2026-09-15
anchors: [apps/api/src/api/openapi.ts, packages/application-control/src/require-runtime/require-runtime.ts, packages/application-control/src/platform-event/run-webhook-consumer.ts, packages/domain/src/run/run.ts]
---
# Control-plane API (`@everdict/api`)

The external surface — a Fastify HTTP server that accepts eval runs and exposes results, on top of what the
runtime provides (capacity-aware, tenant-fair `Scheduler`, trust-zone isolation, per-tenant secrets and budgets).
Runs are **asynchronous**: submit returns `202` with the queued `RunRecord`; the outcome arrives by polling or by
webhook.

## The route reference is generated — this page is not it

Every route's method, path, body, response and error statuses is documented in the OpenAPI document built from
the per-resource descriptors `apps/api/src/api/<domain>/<resource>.docs.ts` and served by a running API at
**`/docs`** (Swagger UI). The descriptors document and never validate (rule `api-layer`: validation stays in the
handlers). This page holds only what the generated reference cannot say.

- **Errors** are one flat envelope `{ code, message, data? }`; the HTTP status derives from the `AppError`
  subtype (`apps/api/src/api/openapi.ts` lists the shared ones): budget → `402 BUDGET_EXCEEDED`, queue
  backpressure → `429 RATE_LIMITED`, bad body → `400`, and another workspace's resource → `404`, never `403`.
- **Identity** is resolved by the auth core (`@everdict/auth`) — see [auth.md](auth.md). The resolved
  `workspace` (= tenant = trust zone) keys fairness, quotas, isolation, secrets and budgets and scopes every read.
- **The same service core** serves the agent-facing MCP server at `/mcp` — see [mcp.md](mcp.md). Batch evals
  (a dataset × a `harness@version`) are [scorecards.md](scorecards.md); workspace membership and keys are
  [tenancy.md](tenancy.md).

## Lifecycle (async)
```
POST /runs ──▶ RunService.submit
                 ├─ assertRuntimeTarget          # no `runtime` and no `self:<runner>` target → 400
                 ├─ preflightPlacement           # the chosen runtime cannot run this harness → 400
                 ├─ budget.admit(tenant)         # over-limit → 402, no run created
                 ├─ store.create(queued)  ───────▶ 202 RunRecord   (webhookUrl is stored ON the record)
                 └─ (tracked) dispatch → Scheduler → Backend → job-runner → settle succeeded | failed
                        └─ terminal fact (run.completed | run.failed) on the event log
                               └─ runs:completion-webhook consumer POSTs the record to webhookUrl
GET /runs/:id ◀── poll until the status is terminal     (or receive the webhook)
```
The API never executes a case on its own host: a run or scorecard with no execution target is refused at
submit (see [execution-backends.md](execution-backends.md)).

The webhook is delivered off the terminal fact, not by the process that finished the run
(`run-webhook-consumer.ts`, mig `0171`): a restart or a replica takeover cannot lose it, and a refused
settlement calls nobody. Delivery is at-least-once — receivers dedup by the `x-everdict-event` header — and the
destination must be HTTPS on a public host; anything else is refused loudly and dead-lettered.

## Result store (`@everdict/db`)
`RunStore` is `InMemoryRunStore` by default; with `DATABASE_URL` set every store is Postgres (`PgRunStore` for
runs), and `migrate()` applies `packages/db/migrations/` at boot. Migration discipline: `docs/migration/`.

The **trajectory store** (the owned trace ledger: eval runs · agent turns · OTLP-door arrivals · materialized
imports) is the one store with a second engine: `EVERDICT_CLICKHOUSE_URL` swaps it to
`ClickHouseTrajectoryStore` while every other store keeps `DATABASE_URL`. Compose ships the engine behind
`--profile clickhouse`; the swap copies nothing, so already-sealed trajectories stay in the engine that wrote them.
Neighbouring knobs: `EVERDICT_INGEST_MAX_EVENTS_PER_HOUR` (OTLP-door quota) and
`EVERDICT_TRAJECTORY_RETENTION_DAYS` (ledger retention).

### Run audience — personal executions are their owner's

`runs:read` says a member may read this workspace's executions; it does not say they may read each OTHER's.
An interactive **agent run** is a conversation turn and a **sandbox session** is somebody's shell, so both are
readable only by the member they belong to — `origin.actor`, else `createdBy`. Everything else (evals, the
playground cases a session runs, analyses) stays workspace-visible, and so do a record stamped
`visibility: "workspace"`, a background agent activation (fleet observability), and a personal run with no
member on it (hiding evidence from everyone is loss, not privacy). There is deliberately **no admin bypass**: an
admin who could open every member's transcript would make that ownership decorative — what an admin legitimately
needs (who spent what) reads off the usage meter, which carries cost without content.

The rule is `runAudience`/`canReadRun` in `@everdict/domain`, applied at three depths so no surface can forget
it: `RunService.list/getForDisplay/trajectory` (both transports inherit it), the run observability routes via
`runVisible` (route-context), and the ledger itself — every sealed trajectory carries an `owner` (mig `0116`), so
`GET /trajectories` filters in the query and `GET /trajectories/:id` answers 404 for someone else's. Refusals are
**404, never 403** — the same answer as another workspace's run, so neither leaks that the row exists.

## Run it
```bash
pnpm build
pnpm api          # node --env-file-if-exists=apps/api/.env apps/api/dist/main.js  (PORT, default 8787)
```
The boot line names what was wired: `backend:nomad|k8s|runtime-only`, `store:postgres|memory`,
`auth:required|dev-fallback`, `runtime:required`. `EVERDICT_AGENT_IMAGE` plus `NOMAD_ADDR` (or
`EVERDICT_K8S_CONTEXT`) registers a deployment backend; the submit gate still requires every run to name an
execution target. `EVERDICT_TENANT_RUNS` / `EVERDICT_TENANT_USD` are the env fallback budget for tenants with no
stored limit. `EVERDICT_TEMPORAL_ADDRESS` makes batch scorecards durable — see [orchestration.md](orchestration.md).

The CLI (`everdict run`) is the single-host dev path that owns `LocalBackend`; this API is the multi-tenant
control-plane surface.
