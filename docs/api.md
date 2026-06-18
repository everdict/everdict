# Control-plane API (`@assay/api`)

The external SaaS surface — a Fastify HTTP server that accepts eval runs and exposes results, on top of
everything the runtime provides (capacity-aware + tenant-fair `Scheduler`, trust-zone isolation, per-tenant
secrets/budgets, autoscaling). Runs are **asynchronous**: submit returns immediately with a `runId`; the result
arrives by polling or webhook.

## Endpoints
| Method | Path | Body / result |
|---|---|---|
| `GET`  | `/me` | the caller's `Principal{subject,workspace,roles,via}` |
| `POST` | `/runs` | `{ harness:{id,version}, case:EvalCase, webhookUrl? }` → **202** `RunRecord` (`runs:submit`) |
| `GET`  | `/runs/:id` | `RunRecord` (200) or 404 (`runs:read`) |
| `GET`  | `/runs` | `RunRecord[]` for the caller's workspace (`runs:read`) |
| `GET`  | `/healthz` | `{ ok: true }` |

Identity is resolved by the **auth core** (`@assay/auth`): `Authorization: Bearer <jwt|ak_…>` → a
`Principal{subject, workspace, roles, via}` (OIDC/Keycloak JWT or API key). With `ASSAY_REQUIRE_AUTH=1` a
missing/invalid credential is **401**, otherwise dev falls back to the `x-assay-tenant` header (admin). The
resolved `workspace` (= tenant = trust-zone) keys fairness, quotas, isolation, secret scoping, budgets — and
scopes every read; roles gate every route (`viewer/member/admin`). See [auth.md](auth.md). Harness registration
(`POST/GET /harnesses`, workspace-owned) and key issuance (`POST /internal/tenant-keys`) are covered in
[tenancy.md](tenancy.md).

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

## Result store (`@assay/db`)
`RunStore` (create/update/get/list). Default `InMemoryRunStore`; set `DATABASE_URL` and the API uses
**`PgRunStore`** (real Postgres) — it runs migrations at boot (`migrate()` over `packages/db/migrations/`,
idempotent) and persists `RunRecord`s (`result`/`error` as `jsonb`). Same interface, so the service +
lifecycle are unchanged. Migration discipline: `docs/migration/`. ClickHouse (analytics) can be added the
same way behind `RunStore`.

## Run it
```bash
pnpm build
# local backend (this machine's claude subscription):
PORT=8787 node apps/api/dist/main.js
# distributed backend + per-tenant run cap + Postgres result store:
PORT=8787 NOMAD_ADDR=http://127.0.0.1:4646 ASSAY_AGENT_IMAGE=<img> ASSAY_TENANT_RUNS=3 \
  DATABASE_URL=postgresql://user:pass@host:5432/db node apps/api/dist/main.js   # migrations run at boot

curl -XPOST localhost:8787/runs -H 'x-assay-tenant: acme' -H 'content-type: application/json' -d '{
  "harness": {"id":"scripted","version":"latest"},
  "case": {"id":"c1","env":{"kind":"repo","source":{"files":{}}},"task":"...","graders":[{"id":"steps"}],"timeoutSec":120,"tags":[]}
}'
curl localhost:8787/runs/<runId>   # poll until "succeeded"
```
Live-verified end-to-end against real Nomad: `POST /runs` → `202` → poll → `succeeded` with trace + snapshot +
scores; a 4th submit past `ASSAY_TENANT_RUNS=3` returns `402 BUDGET_EXCEEDED`. With `DATABASE_URL` set, the
succeeded run is confirmed persisted in the `assay_runs` Postgres table (survives a server restart).

> The CLI (`assay run`) is the dev/single-run path; this API is the multi-tenant control-plane surface.
> Durable orchestration (Temporal) and the API can be combined: point the service's dispatcher at the Temporal
> orchestrator instead of an in-process Scheduler. See `docs/orchestration.md`.
