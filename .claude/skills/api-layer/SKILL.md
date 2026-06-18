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
(background) `dispatcher.dispatch(job)` → on success `budget.settle(costOf)` + `store.update(succeeded, result)`,
on error `store.update(failed, envelope)` → optional `webhookUrl` POST of the final record. The dispatcher is a
`Dispatcher` — an in-process `Scheduler` (default) or the Temporal orchestrator for the durable path.

## Result store
`RunStore` (create/update/get/list). Default `InMemoryRunStore`; production swaps a Postgres/ClickHouse impl
behind the same interface (migrations per `docs/migration/`) — service, routes, lifecycle unchanged.

## Reference impl
`apps/api/src/{server,run-service,run-store,main}.ts`. Live-verified end-to-end against real Nomad
(`POST /runs` → poll → succeeded; 402 past the run budget).
