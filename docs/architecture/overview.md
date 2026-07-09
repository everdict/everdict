# Architecture overview

Detailed conventions live in `.claude/skills/` (single source of truth). This file is the
human-facing map. For the *collaboration* view — who calls whom, drawn as diagrams at two zoom
levels (whole-mesh + per-module) — see [`collaboration.md`](collaboration.md).

## The spine: 4 in-sandbox concerns + a placement layer
| Concern | Interface (`@everdict/core`) | impl |
|---|---|---|
| Harness (under test) | `EvaluableHarness` | `claude-code`, `scripted` |
| Environment (world acted on) | `Environment<EnvSnapshot>` | `RepoEnvironment` |
| Driver (in-sandbox compute) | `Driver` / `ComputeHandle` | `LocalDriver` (dev / inside the agent) |
| Grader (how we judge) | `Grader` | `tests-pass`, `cost`, `steps`, `latency` |
| **Backend** (placement) | `Backend` | `LocalBackend`, `NomadBackend` (K8s/Windows later) |

## The eval loop (runs inside the dispatched agent)
provision(Driver) → seed(Environment) → install+run(Harness)→normalized trace →
snapshot(Environment) → grade(Grader[]) → `CaseResult`.

The **Backend** dispatches the runner-agent (`@everdict/agent`) — which runs the loop above via
`LocalDriver` inside an isolated job — and parses the returned result. Isolation is the
orchestrator's (Nomad task `runtime` / K8s `runtimeClassName` / Windows VM). Suites fan out over
cases × harness versions; regression = diff two scorecards.
See `docs/execution-backends.md` (Backend vs Driver) and `docs/sandbox-auth.md` (claude auth).

## Extension (no core rewrite)
- new compute target (Nomad/K8s/Windows) → new `Backend` (agent + loop unchanged).
- OS Win/macOS on a pool → `Backend` + per-run VM checkpoint isolation.
- env browser/os-use → new `Environment` + snapshot variant (+ a `Computer` capability for os-use).
- harness Codex/LangGraph → new `EvaluableHarness` (+ registry entry in `@everdict/agent`); any CLI with
  zero code via the declarative `command` harness (`docs/command-harness.md`).
- **service-topology harness** (multi-service + browser/OS target env) → `HarnessSpec(service)` +
  orchestrator-agnostic `ServiceTopologyBackend` (Nomad/K8s) + `@everdict/trace` (OTel/MLflow). See `docs/service-harness.md`.
- new scoring signal → new `Grader` (+ registry entry). A model-backed `Grader` is an Agent Judge.
- run on the *user's own* machine → the push model flips to **pull**: `SelfHostedBackend` parks jobs in an
  owner-scoped lease queue; `@everdict/self-hosted-runner` (shared by the `everdict runner` CLI and the **desktop app**
  `apps/desktop`, which adds one-click pairing + tray residency) leases → runs the same eval loop locally →
  posts the result back with a provenance tag. See `architecture/self-hosted-runner.md` +
  `architecture/desktop-app.md`.

## Operational layer (multi-tenant SaaS)
Above placement, the control plane turns "run one case" into "serve many tenants on finite/elastic infra":
- **Scheduler** (`@everdict/backends`) — capacity-aware placement (`Backend.capacity()`, `PlacementPolicy`) +
  tenant-fair queue (WFQ, `tenantQuota`) + backpressure (`RateLimitError` 429). Drop-in `Dispatcher` for `Router`.
- **Trust zones** (`TrustZonePolicy`) — eval runs untrusted code, so each tenant is isolated (hardened runtime +
  namespace) and **warm pools are never shared across tenants**. **Secrets** (`SecretProvider`) are per-tenant.
- **Budgets** (`BudgetTracker`) — per-tenant `{usd, tokens, runs}` admission (`PaymentRequiredError` 402) + cost
  accounting. **Autoscaler** — grows/shrinks capacity from queue depth.
- **HTTP surface** (`apps/api`, Fastify) — async `POST /runs` → run-id, `GET /runs/:id` poll, webhooks; batch
  **scorecards** (dataset×harness → `Scorecard`+summary, baseline↔candidate diff, push/pull trace ingest,
  harness×model leaderboard, cron **schedules** on Temporal), **bundles** (one-shot install), workspace
  **integrations** (GitHub App + Mattermost) + **runners**, CI triggers; stores: `RunStore` + `ScorecardStore` (in-memory or `Pg*`
  on Postgres via `DATABASE_URL`). Full **BFF↔MCP parity** (`/mcp`). See `docs/api.md` + `docs/mcp.md` +
  `docs/scorecards.md`.
- **Registry** (`@everdict/registry`) — the version SSOT for **harnesses · datasets · judges · runtimes**:
  `(tenant, id, version)` (immutable versions, semver `latest`, tenant-owned + `_shared` fallback; in-memory /
  file-GitOps / `Pg*` on Postgres). `ServiceTopologyBackend.specFor` resolves a job's `{id, version}` reference
  to a concrete spec at dispatch. See `docs/registry.md` + `docs/datasets.md` + `docs/judges.md` +
  `docs/runtimes.md`.
- **Auth core** (`@everdict/auth`, owned by `apps/api`) — every credential resolves to a `Principal{subject,
  workspace, roles, via}`: OIDC/Keycloak JWT (verified via `jose` JWKS) for humans, API keys (`ak_…`) for
  agents/MCP/CI, behind one `compositeAuthenticator`. `workspace = tenant = trust-zone`; a role→action matrix
  (`viewer/member/admin`) gates every route. The web is a token courier, **not** an auth authority. See `docs/auth.md`.
- **Tenant access + human surfaces** — tenant-owned entities and workspace-scoped reads (`docs/tenancy.md`); the
  `apps/web` Next.js dashboard (Keycloak user login, `/{workspace}/…`) is a pure HTTP client of the control
  plane (`docs/web.md`), and the `apps/desktop` Electron shell renders that same web (parity by construction)
  while embedding the self-hosted runner (`architecture/desktop-app.md`). Humans → Keycloak; agents → API keys.

## Cross-cutting
- Cost/token capture comes from the harness trace (e.g. Claude's `total_cost_usd` in stream-json); the same
  trace cost feeds per-tenant budgets (`sumCost`).
- External/orchestrator failures are remapped to `AppError` (never propagated raw); HTTP maps `AppError.status`.
- Durable dispatch+await is implemented via `@everdict/orchestrator` (Temporal): a worker runs the
  `dispatchCase` activity (a `Dispatcher` — the capacity-aware `Scheduler` → backend); the client starts/awaits a
  workflow. See `docs/orchestration.md`.
