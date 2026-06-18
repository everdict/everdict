# Architecture overview

Detailed conventions live in `.claude/skills/` (single source of truth). This file is the
human-facing map.

## The spine: 4 in-sandbox concerns + a placement layer
| Concern | Interface (`@assay/core`) | impl |
|---|---|---|
| Harness (under test) | `EvaluableHarness` | `claude-code`, `scripted` |
| Environment (world acted on) | `Environment<EnvSnapshot>` | `RepoEnvironment` |
| Driver (in-sandbox compute) | `Driver` / `ComputeHandle` | `LocalDriver` (dev / inside the agent) |
| Grader (how we judge) | `Grader` | `tests-pass`, `cost`, `steps`, `latency` |
| **Backend** (placement, model B) | `Backend` | `LocalBackend`, `NomadBackend` (K8s/Windows later) |

## The eval loop (runs inside the dispatched agent)
provision(Driver) → seed(Environment) → install+run(Harness)→normalized trace →
snapshot(Environment) → grade(Grader[]) → `CaseResult`.

The **Backend** dispatches the runner-agent (`@assay/agent`) — which runs the loop above via
`LocalDriver` inside an isolated job — and parses the returned result. Isolation is the
orchestrator's (Nomad task `runtime` / K8s `runtimeClassName` / Windows VM). Suites fan out over
cases × harness versions; regression = diff two scorecards.
See `docs/execution-backends.md` (Backend vs Driver) and `docs/sandbox-auth.md` (claude auth).

## Extension (no core rewrite)
- new compute target (Nomad/K8s/Windows) → new `Backend` (agent + loop unchanged).
- OS Win/macOS on a pool → `Backend` + per-run VM checkpoint isolation.
- env browser/os-use → new `Environment` + snapshot variant (+ a `Computer` capability for os-use).
- harness Codex/LangGraph → new `EvaluableHarness` (+ registry entry in `@assay/agent`).
- **service-topology harness** (multi-service + browser/OS target env) → `HarnessSpec(service)` +
  orchestrator-agnostic `ServiceTopologyBackend` (Nomad/K8s) + `@assay/trace` (OTel/MLflow). See `docs/service-harness.md`.
- metric → new `Grader` (+ registry entry).

## Operational layer (multi-tenant SaaS)
Above placement, the control plane turns "run one case" into "serve many tenants on finite/elastic infra":
- **Scheduler** (`@assay/backends`) — capacity-aware placement (`Backend.capacity()`, `PlacementPolicy`) +
  tenant-fair queue (WFQ, `tenantQuota`) + backpressure (`RateLimitError` 429). Drop-in `Dispatcher` for `Router`.
- **Trust zones** (`TrustZonePolicy`) — eval runs untrusted code, so each tenant is isolated (hardened runtime +
  namespace) and **warm pools are never shared across tenants**. **Secrets** (`SecretProvider`) are per-tenant.
- **Budgets** (`BudgetTracker`) — per-tenant `{usd, tokens, runs}` admission (`PaymentRequiredError` 402) + cost
  accounting. **Autoscaler** — grows/shrinks capacity from queue depth.
- **HTTP surface** (`apps/api`, Fastify) — async `POST /runs` → run-id, `GET /runs/:id` poll, webhooks, `RunStore`
  (in-memory; Postgres/ClickHouse behind the interface). See `docs/api.md` + `docs/execution-backends.md`.

## Cross-cutting
- Cost/token capture comes from the harness trace (e.g. Claude's `total_cost_usd` in stream-json); the same
  trace cost feeds per-tenant budgets (`sumCost`).
- External/orchestrator failures are remapped to `AppError` (never propagated raw); HTTP maps `AppError.status`.
- Durable dispatch+await is implemented via `@assay/orchestrator` (Temporal): a worker runs the
  `dispatchCase` activity (a `Dispatcher` — the capacity-aware `Scheduler` → backend); the client starts/awaits a
  workflow. See `docs/orchestration.md`.
