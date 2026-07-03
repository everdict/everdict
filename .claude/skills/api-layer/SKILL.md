---
name: api-layer
description: The control-plane HTTP API (apps/api, Fastify) — async POST /runs + poll/webhook, RunStore, multi-tenant via x-assay-tenant, flat error envelopes. Use when adding or editing API routes/services/the result store.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# API layer (`apps/api`)

The external SaaS surface. A Fastify server over the runtime (Scheduler + trust zones + secrets + budgets +
autoscaling). Runs are **async**: submit returns a `runId`; the result arrives by polling or webhook. See
`docs/api.md`. Rule: `.claude/rules/api-layer.md`.

## Layering (digo-api reinterpretation)
- **server.ts** = routes only (registration + HTTP), **run-service.ts** = logic (framework-agnostic),
  **run-store.ts** = persistence. Routes never hold business logic; the service never touches HTTP.
- Request/response schemas are Zod (`SubmitBodySchema`, `RunRecordSchema`) — external input is validated.
- Error envelopes are **flat** `{code, message, data?}` from `AppError.toEnvelope()`; status from
  `AppError.status` (budget→402, queue→429, not-found→404, bad-body→400). No success envelope (send the record).

## Endpoints
`POST /runs` → **202** `RunRecord(queued)` · `GET /runs/:id` (poll) · `GET /runs` (per-tenant) · `GET /healthz`.
Tenant from the `x-assay-tenant` header (default `default`) — keys fairness, quotas, isolation, secrets, budgets.

## Run lifecycle (`RunService`)
`submit`: `budget.admit(tenant)` (over-limit → 402, no run created) → `store.create(queued)` → return 202 →
(background) `executeCase` → on success `budget.settle(costOf)` + `store.update(succeeded, result)`,
on error `store.update(failed, envelope)` → optional `webhookUrl` POST of the final record. The dispatcher is a
`Dispatcher` — an in-process `Scheduler` (default) or the Temporal orchestrator for the durable path.

## Three concerns: execution · orchestration · scoring (don't re-tangle)
Control-plane runs/scorecards are split by concern — see `docs/architecture/execution-scoring-orchestration.md`.
- **Execution** = `execute-case.ts` `executeCase(deps, owner, job) → CaseResult` — **pure**: repo-token + dispatch.
  No settle/offload/notify. `RunService` and `ScorecardService` both call it; the shared unit is execution, NOT the
  single-run orchestrator (never route the batch through `RunService.submit`).
- **Scoring** = `scoring-service.ts` `ScoringService` — judge application over results, independent of how
  they were produced. Live batch **and** ingest share it; aggregation (passRate/mean summary) stays pure in `@assay/suite`.
- **Orchestration** = the services drive execution (single/batch) and own admit/settle, delivery (202/webhook),
  notify, progress. `run` is just execution — the "after" belongs to the orchestrator.

## Result store (`@assay/db`)
`RunStore` (create/update/get/list). Default `InMemoryRunStore`; with `DATABASE_URL` the API uses `PgRunStore`
(Postgres, `result`/`error` as jsonb) and runs idempotent SQL migrations at boot — service/routes/lifecycle
unchanged. Migrations: `packages/db/migrations/` + discipline in `docs/migration/`. The store + migrator share an
injectable `SqlClient` (fake in tests, `pg.Pool` in prod).

## Reference impl
`apps/api/src/{server,run-service,run-store,main}.ts`. Live-verified end-to-end against real Nomad
(`POST /runs` → poll → succeeded; 402 past the run budget).
