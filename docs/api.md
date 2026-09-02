---
kind: wiki
title: "Control-plane API (@everdict/api)"
status: current
updated: 2026-08-05
---
# Control-plane API (`@everdict/api`)

The external SaaS surface — a Fastify HTTP server that accepts eval runs and exposes results, on top of
everything the runtime provides (capacity-aware + tenant-fair `Scheduler`, trust-zone isolation, per-tenant
secrets/budgets, autoscaling). Runs are **asynchronous**: submit returns immediately with a `runId`; the result
arrives by polling or webhook.

## Endpoints
| Method | Path | Body / result |
|---|---|---|
| `GET`  | `/me` | the caller's `Principal{subject,workspace,roles,via}` |
| `POST` | `/runs` | `{ harness:{id,version}, case:EvalCase, runtime?, webhookUrl? }` → **202** `RunRecord` (`runs:submit`). `runtime` → `case.placement.target` (same runtime targeting as `/scorecards`). |
| `GET`  | `/runs/:id` | `RunRecord` (200) or 404 (`runs:read`; another member's PERSONAL execution is 404 too — see below) |
| `GET`  | `/runs` | `RunRecord[]` for the caller's workspace, minus other members' personal executions (`runs:read`) |
| `GET`  | `/runs/:id/trajectory` | the run's **owned trajectory** (P5 rung 1): sealed `TraceEvent[]` from `everdict_trajectories`, embed fallback during dual-read — `meta.source` says which copy served (`runs:read`) |
| `GET`  | `/trajectories` | browse the owned evidence ledger (N1 look-inward): sealed metas `{runId, source, eventCount, sealedAt}`, newest first, cursor-paginated — Settings › Traces' primary section reads this (`runs:read`; MCP `list_trajectories`) |
| `GET`/`PUT` | `/workspace/trace-thresholds` | E4 perception config: bounds evaluated over every trajectory at seal — a crossing lands `trace.threshold_crossed` on the event log (read `runs:read`, write `settings:write`; MCP `get/set_workspace_trace_thresholds`) |
| `GET`/`PUT` | `/workspace/trace-ingestion` | N3 admission lane: the OTLP door's events/hour quota (workspace override > operator `EVERDICT_INGEST_MAX_EVENTS_PER_HOUR` > unlimited) + last-hour usage + retention TTL; past the bound the door 429s and lands `trace.ingestion_throttled` (read `runs:read`, write `settings:write`; MCP `get/set_workspace_trace_ingestion`) |
| `POST` | `/v1/traces` | **OTLP/HTTP door** (N0): standard OTLP JSON; spans group by `everdict.run_id` and seal in the owned TrajectoryStore — point `OTEL_EXPORTER_OTLP_ENDPOINT` here with a tenant API key in the headers (`runs:submit`) |
| `POST` | `/sandboxes` | **sandbox session run** (P6): boot an environment image (or an adopted environment capability, or a **registered harness** — the playground: warm-installed once, then test cases drive it) as a long-lived container — a Run{kind:sandbox, lifetime:session} born running with a hard TTL on the row; opt-in via `EVERDICT_SANDBOX_DRIVER=docker`, per-tenant caps → 429 (`runs:submit`; MCP `create_sandbox`) |
| `GET` | `/sandboxes` (+`/:id`) | the reattach surface: live sessions with record + live meta (expiresAt, busy, booted harness, task summaries) — what the web playground panel polls (`runs:read`; MCP `list_sandboxes`/`get_sandbox`) |
| `POST` | `/sandboxes/:id/tasks` | **playground test case**: run the session's harness on an ad-hoc prompt (no dataset, no graders) → 202 child Run{kind:eval, class:interactive, group→session}, fresh workdir per case in the warm container; one at a time (409), budget admission (402) (`runs:submit`; MCP `submit_sandbox_task`) — see `docs/architecture/harness-playground.md` |
| `GET` | `/sandboxes/:id/tasks/:taskId/trace` | the 2s live cursor (`?since=` index into the task's append-only buffer; omitted = full replay) — a streaming harness shows tool calls mid-run; after settle the sealed trajectory serves the same events, `done:true` stops the poll (`runs:read`; MCP `read_sandbox_task_trace`) |
| `POST` | `/sandboxes/:id/exec` | one `sh -c` command into the live session, creator-or-admin BEFORE it runs; every exec lands on the session trajectory, sealed at teardown and served by `GET /runs/:id/trajectory` (`runs:read`; MCP `sandbox_exec`) |
| `POST` | `/sandboxes/:id/close` | tear down (dispose in a `finally`; an in-flight task is aborted and settles failed{CANCELLED} with partial evidence sealed), seal the trajectory, settle succeeded with `session.closedReason` — idempotent; a handle lost to a restart settles as `orphaned` (`runs:read`; MCP `close_sandbox`) |
| `POST` | `/datasets` | register a `Dataset` (immutable → `409`) (`datasets:write`, member+) |
| `POST` | `/datasets/validate` | dry-run: schema + existing versions/conflict, no write (`datasets:write`) |
| `GET`  | `/datasets` | workspace-owned + `_shared` datasets (`datasets:read`) |
| `GET`  | `/datasets/:id/versions/:version` | full `Dataset` incl. cases; `version` may be `latest` (`datasets:read`) |
| `DELETE` | `/datasets/:id/versions/:version` | soft-delete one version (tombstone, data preserved); creator **or** admin (`datasets:delete`); exact `version` required → `404`/`403` |
| `GET`  | `/datasets/:id/diff?base=&candidate=` | version diff: added/removed/changed cases + meta; `base`/`candidate` may be `latest` (`datasets:read`) |
| `POST` | `/judges` | register a `JudgeSpec` (model \| harness; immutable → `409`) (`judges:write`, member+) |
| `POST` | `/judges/validate` | dry-run: schema + existing versions/conflict, no write (`judges:write`) |
| `GET`  | `/judges` | workspace-owned + `_shared` Agent Judges (`judges:read`) |
| `GET`  | `/judges/:id/versions/:version` | full `JudgeSpec`; `version` may be `latest` (`judges:read`) |
| `POST` | `/runtimes` | register a `RuntimeSpec` (local \| nomad \| k8s; immutable → `409`) (`runtimes:write`) |
| `POST` | `/runtimes/validate` | dry-run: schema + existing versions/conflict, no write (`runtimes:write`) |
| `GET`  | `/runtimes` | workspace-owned + `_shared` execution runtimes (`runtimes:read`) |
| `GET`  | `/runtimes/:id/versions/:version` | full `RuntimeSpec`; `version` may be `latest` (`runtimes:read`) |
| `POST` | `/scorecards` | `{ dataset, harness, judges?, runtime? }` → **202** `ScorecardRecord(queued)` (`scorecards:run`, member+) |
| `POST` | `/groups` | run an **experiment** (ungraded phase-1 group, execution-model P1): `{ harness, dataset \| task:{prompt}, trials?, runtime? }` → **202** `ScorecardRecord(kind:"experiment")` — graders stripped, no judges/verdict; excluded from leaderboard/trend/analysis (`scorecards:run`) |
| `GET`  | `/groups/:id` | the group record with hydrated detail — same record as `/scorecards/:id`, kind-aware name (`scorecards:read`) |
| `POST` | `/groups/:id/score` | phase 2 detached (P2): `{ judges[] }` → **202** — judge an existing group's runs, re-write the aggregate; re-score replaces a judge's verdicts, scoring an experiment **promotes** it (`scorecards:run`) |
| `GET`  | `/ops/driver/:family/:id` | **Driver ops surface v0**: describe the durable Temporal driver by LEDGER id (`family` = `batch`\|`score`) — status, history pressure, pending activities with last failure (`runtimes:read`; 404 without a Temporal address) |
| `POST` | `/ops/driver/:family/:id/cancel` | cooperatively cancel the durable driver (ledger settles via the CP's own guards) (`runtimes:control`, admin) |
| `GET`  | `/approvals` | durable agent approvals (A6): the workspace's parked agent mutations, `?status=` filter — an ask survives an agent-service restart (`agents:read`) |
| `POST` | `/approvals/:id/decide` | `{ decision: approve\|deny }` → settles exactly once (409 after); a LIVE wait gets it delivered (`delivered:true`), a dead park RESUMES as a continuation turn (`resumed:true`) (`agents:write`) |
| `POST` | `/scorecards/ingest` | `{ dataset, harness, traces:[{caseId,trace:TraceEvent[]}], judges? }` → **202** (no harness run; push) (`scorecards:run`) |
| `POST` | `/scorecards/ingest/pull` | `{ dataset, harness, source:{kind:otel\|mlflow,endpoint,authSecret?}, runs:[{caseId,runId}], judges? }` → **202** (pull from tenant OTel/MLflow; `authSecret`=SecretStore key) (`scorecards:run`) |
| `GET`  | `/scorecards` | `ScorecardRecord[]` (summary only, no heavy per-case results) (`scorecards:read`) |
| `GET`  | `/scorecards/:id` | full `ScorecardRecord` (incl. per-case `scorecard`) or 404 (`scorecards:read`) |
| `GET`  | `/scorecards/diff?baseline=&candidate=` | `ScorecardDiff` (metric Δ + regressions/improvements) (`scorecards:read`) |
| `POST` | `/keys` | self-serve issue an API key `{ label?, scopes? }` → **201** `{ apiKey }` (plaintext **once**; `scopes` = `read\|write\|admin`, omitted = Full Access/`admin`) (`keys:write`, admin) |
| `GET`  | `/keys` | API key metadata `{ id, prefix, label?, scopes?, createdAt }[]` — never the plaintext/hash; `scopes` absent = Full Access (`keys:read`, admin) |
| `DELETE` | `/keys/:id` | revoke a key → **204** (tenant-scoped; foreign id is a no-op) (`keys:write`, admin) |
| `GET`  | `/workspace/pulse` | the home screen's ONE read: state now (open/regressed issues · active cycles + their commitment · goals & projects at risk · open agent tasks + pending approvals · window pass rate vs. the preceding window) + the trend over `days` (activity per day by axis · issues in vs. out · pass rate per day), folded from the platform-event log. Team-privacy scoped; `issues:read`, viewer+ (MCP `get_workspace_pulse`) — see `docs/architecture/workspace-pulse.md` |
| `GET`  | `/members` | workspace members `{ subject, role, email?, addedAt }[]` (`members:read`, viewer+) |
| `PATCH` | `/members/:subject` | change a member's `{ role }` → **204** (404 if not a member; **409** last-admin) (`members:write`, admin) |
| `DELETE` | `/members/:subject` | remove a member → **204** (idempotent; **409** last-admin) (`members:write`, admin) |
| `POST` | `/invites` | mint a reusable join link `{ role, expiresInHours? }` → **201** `{ …, token }` (plaintext `inv_…` **once**) (`members:write`, admin) |
| `GET`  | `/invites` | active invite links (meta only, no token/hash; incl. `acceptedCount`) (`members:write`, admin) |
| `DELETE` | `/invites/:id` | revoke an invite link → **204** (tenant-scoped) (`members:write`, admin) |
| `POST` | `/invites/accept` | redeem `{ token }` → `{ workspace, role }` (authenticated **human** only, not workspace-gated; reusable until expired/revoked) |
| `GET`  | `/healthz` | `{ ok: true }` |

Scorecards are **batch evals** (a dataset × a `harness@version` → aggregated `Scorecard` + per-metric summary),
async like runs. See [scorecards.md](scorecards.md).

Identity is resolved by the **auth core** (`@everdict/auth`): `Authorization: Bearer <jwt|ak_…>` → a
`Principal{subject, workspace, roles, via}` (OIDC/Keycloak JWT or API key). With `EVERDICT_REQUIRE_AUTH=1` a
missing/invalid credential is **401**, otherwise dev falls back to the `x-everdict-tenant` header (admin). The
resolved `workspace` (= tenant = trust-zone) keys fairness, quotas, isolation, secret scoping, budgets — and
scopes every read; roles gate every route (`viewer/member/admin`). See [auth.md](auth.md). Harness registration
(`POST/GET /harnesses` instances + `POST/GET /harness-templates` top-level categories; raw config reads
`GET /harnesses/:id/:version/instance` [template ref + pins] and `GET /harness-templates/:id/:version` [structure]
power the web Config panel + new-version prefill; `GET /harnesses/:id/diff?base=&candidate=` diffs two versions'
resolved specs [config changes by field path — e.g. `services[x].image`; `base`/`candidate` may be `latest`] — `harnesses:read`), datasets (`POST/GET /datasets`, workspace-owned + `_shared`, see
[datasets.md](datasets.md)) and key issuance (admin self-serve `POST/GET/DELETE /keys` — issued keys carry
workspace admin role, narrowable by per-key `scopes` (`read|write|admin`, omitted = Full Access), plaintext shown
once, hash-only at rest; bootstrap `POST /internal/tenant-keys`) are covered in [tenancy.md](tenancy.md).
`GET /harnesses/:id/delegate?slot=&version=` answers WHO maintains a slot's code — the delegation profile the
template's `source.maintainer` names for that slot, or a named miss (`unmapped` · `ambiguous` · `no_such_slot`) — so an
evolution driver looks the specialist up instead of asking (`docs/architecture/evolution-routing-spec.md` §1).

`RunRecord` = `{ id, tenant, harness, caseId, status: queued|running|succeeded|failed, result?, error?,
createdAt, updatedAt }`. Errors map by `AppError.status`: budget → **402** `BUDGET_EXCEEDED`, queue full →
**429** `RATE_LIMITED`, unknown backend → **404**, bad body → **400**.

## Lifecycle (async)
```
POST /runs ──▶ RunService.submit
                 ├─ budget.admit(tenant)        # over-limit → 402 (no run created)
                 ├─ store.create(queued) ───────▶ 202 { runId }
                 └─ (background) dispatcher.dispatch(job)   # Scheduler → Backend → agent
                        ├─ ok   → budget.settle(cost); store.update(succeeded, result)
                        └─ err  → store.update(failed, errorEnvelope)
                        └─ webhookUrl? → POST the final RunRecord
GET /runs/:id ◀── poll until status is terminal     (or receive the webhook)
```

## Result store (`@everdict/db`)
`RunStore` (create/update/get/list). Default `InMemoryRunStore`; set `DATABASE_URL` and the API uses
**`PgRunStore`** (real Postgres) — it runs migrations at boot (`migrate()` over `packages/db/migrations/`,
idempotent) and persists `RunRecord`s (`result`/`error` as `jsonb`). Same interface, so the service +
lifecycle are unchanged. Migration discipline: `docs/migration/`.

### Run audience — personal executions are their owner's

`runs:read` says a member may read this workspace's executions; it does not say they may read each OTHER's.
An **agent run** is a conversation turn (the session store has always been owner-scoped) and a **sandbox
session** is somebody's shell, so both are readable only by the member they belong to — `origin.actor`, else
`createdBy`. Everything else (evals, the playground cases a session runs, analyses) stays workspace-visible,
and a personal run with no member stamped on it stays workspace-visible too (hiding evidence from everyone is
loss, not privacy). There is deliberately **no admin bypass**: listing/renaming/deleting a conversation is
owner-only, and an admin who could open every member's transcript would make that ownership decorative — what
an admin legitimately needs (who spent what) reads off the usage meter, which carries cost without content.

The rule is `runAudience`/`canReadRun` in `@everdict/domain`, applied at three depths so no surface can forget
it: `RunService.list/getForDisplay/trajectory` (both transports inherit it), the run observability routes via
`runVisible` (route-context), and the ledger itself — every sealed trajectory carries an `owner` (mig 0116,
backfilled from the run ledger), so `GET /trajectories` filters IN the query and `GET /trajectories/:id`
answers 404 for someone else's. Refusals are **404, never 403** — the same answer as another workspace's run,
so neither leaks that the row exists.

The **trajectory store** (the owned trace ledger: eval runs · agent turns · OTLP-door arrivals · materialized
imports) is the one store with a second engine: `EVERDICT_CLICKHOUSE_URL` swaps it to `ClickHouseTrajectoryStore`
(table created at boot) while every other store keeps `DATABASE_URL`. Compose ships the engine behind
`--profile clickhouse`; the swap copies nothing, so already-sealed trajectories stay in the engine that wrote
them. Neighbouring knobs: `EVERDICT_INGEST_MAX_EVENTS_PER_HOUR` (OTLP-door quota) and
`EVERDICT_TRAJECTORY_RETENTION_DAYS` (ledger retention).

## Run it
```bash
pnpm build
# local backend (this machine's claude subscription):
PORT=8787 node apps/api/dist/main.js
# distributed backend + per-tenant run cap + Postgres result store:
PORT=8787 NOMAD_ADDR=http://127.0.0.1:4646 EVERDICT_AGENT_IMAGE=<img> EVERDICT_TENANT_RUNS=3 \
  DATABASE_URL=postgresql://user:pass@host:5432/db node apps/api/dist/main.js   # migrations run at boot

curl -XPOST localhost:8787/runs -H 'x-everdict-tenant: acme' -H 'content-type: application/json' -d '{
  "harness": {"id":"scripted","version":"latest"},
  "case": {"id":"c1","env":{"kind":"repo","source":{"files":{}}},"task":"...","graders":[{"id":"steps"}],"timeoutSec":120,"tags":[]}
}'
curl localhost:8787/runs/<runId>   # poll until "succeeded"
```
Live-verified end-to-end against real Nomad: `POST /runs` → `202` → poll → `succeeded` with trace + snapshot +
scores; a 4th submit past `EVERDICT_TENANT_RUNS=3` returns `402 BUDGET_EXCEEDED`. With `DATABASE_URL` set, the
succeeded run is confirmed persisted in the `everdict_runs` Postgres table (survives a server restart).

> The CLI (`everdict run`) is the dev/single-run path; this API is the multi-tenant control-plane surface.
> Durable orchestration (Temporal) and the API can be combined: point the service's dispatcher at the Temporal
> orchestrator instead of an in-process Scheduler. See `docs/orchestration.md`.

The same control plane also serves the **agent-facing MCP server** at `/mcp` (run/harness tools, OAuth-protected
via Keycloak or API keys, role-gated) plus the OAuth metadata at `/.well-known/oauth-protected-resource`. See
`docs/mcp.md`.
