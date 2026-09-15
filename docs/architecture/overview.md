---
kind: wiki
title: "Architecture overview"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/execution/compute.ts, packages/contracts/src/harness/harness.ts, packages/job-runner/src/registry.ts, packages/registry/src/index.ts, packages/domain/src/auth/principal.ts]
---
# Architecture overview

Detailed conventions live in `.claude/skills/` (single source of truth). This file is the
human-facing map. For the *collaboration* view — who calls whom, drawn as diagrams at two zoom
levels (whole-mesh + per-module) — see [`collaboration.md`](collaboration.md).

The packages sit on one-way layers: `@everdict/contracts` (interfaces + Zod schemas + errors) ←
`@everdict/domain` (the pure kernel) ← `@everdict/application-{execution,control}` (use-cases + ports) ← the
adapter packages below ← `@everdict/job-runner` ← placement and the apps. The per-package table is
`.claude/skills/foundation/references/architecture.md`.

## The eval concerns: 4 in-sandbox + a placement layer
| Concern | Interface (home) | impl |
|---|---|---|
| Harness (under test) | `EvaluableHarness` (`@everdict/contracts`) | `ClaudeCodeHarness`, `ScriptedHarness`, declarative `CommandHarness` (`@everdict/harnesses`) |
| Environment (world acted on) | `Environment<EnvSnapshot>` (`@everdict/contracts`) | `RepoEnvironment`, `PromptEnvironment`, `OsUseEnvironment` (`@everdict/environments`) |
| Driver (in-sandbox compute) | `Driver` / `ComputeHandle` (`@everdict/contracts`) | `LocalDriver` (host process), `DockerDriver` (`case.image` container) |
| Grader (how we judge) | `Grader` (`@everdict/contracts`) | `makeGraders` ids in `packages/graders/src/make-graders.ts` — `tests-pass`, `command`, `script`, `swe-bench`, `reward-file`, `steps`/`cost`/`latency`, `dom-contains`, `judge`, … |
| **Backend** (placement) | `Backend` (`@everdict/backends`) | `LocalBackend`, `DockerBackend`, `NomadBackend`, `K8sBackend`; `ServiceTopologyBackend` (`@everdict/topology`); `SelfHostedBackend` (`apps/api`) |

## The eval loop (runs inside the dispatched job)
provision(Driver) → seed(Environment) → install+run(Harness)→normalized trace →
snapshot(Environment) → grade(Grader[]) → `CaseResult`. The loop is `runCase` in
`@everdict/application-execution`.

The **Backend** dispatches the job-runner (`@everdict/job-runner`) — which runs the loop above inside an
isolated job — and parses the returned result. Isolation is the orchestrator's (Nomad task `runtime` /
K8s `runtimeClassName`). Suites fan out over cases × harness versions; regression = diff two scorecards.
See `docs/execution-backends.md` (Backend vs Driver) and `docs/sandbox-auth.md` (claude auth).

## Extension (no core rewrite)
- new compute target → new `Backend` (job-runner + loop unchanged); a tenant registers one as a `RuntimeSpec`
  (`local` · `nomad` · `k8s`).
- OS Windows/macOS → a runtime whose node pool declares the `os-windows`/`os-macos` capability.
- new world kind → new `Environment` + `EnvSpec`/`EnvSnapshot` variant. `repo`/`prompt`/`os-use` run inside the
  job-runner; `browser` is a service-topology target env.
- harness Codex/LangGraph → new `EvaluableHarness` (+ `makeHarness` entry in `@everdict/job-runner`); any CLI with
  zero code via the declarative `command` harness (`docs/command-harness.md`).
- **service-topology harness** (multi-service + browser/OS target env) → `HarnessSpec(service)` +
  orchestrator-agnostic `ServiceTopologyBackend` (Nomad/K8s) + `@everdict/trace` (OTel/MLflow/Langfuse/LangSmith/Phoenix).
  See `docs/service-harness.md`.
- new scoring signal → new `Grader` (+ `makeGraders` entry). A model-backed `Grader` is an Agent Judge.
- run on the *user's own* machine → the push model flips to **pull**: `SelfHostedBackend` parks jobs in an
  owner-scoped lease queue; `@everdict/self-hosted-runner` (shared by the `everdict runner` CLI and the **desktop app**
  `apps/desktop`, which adds one-click pairing + tray residency) leases → runs the same eval loop locally →
  posts the result back with a provenance tag. See [self-hosted-runner.md](self-hosted-runner.md) +
  [desktop-app.md](desktop-app.md).

## Operational layer (multi-tenant SaaS)
Above placement, the control plane turns "run one case" into "serve many tenants on finite/elastic infra":
- **Scheduler** (`@everdict/backends`) — capacity-aware placement (`Backend.capacity()`, `PlacementPolicy`) +
  tenant-fair queue (WFQ `FairQueue`, `tenantQuota`) + backpressure (`RateLimitError` 429). Drop-in `Dispatcher` for `Router`.
- **Trust zones** (`TrustZonePolicy`, `@everdict/domain`) — eval runs untrusted code, so each tenant is isolated
  (hardened runtime + namespace) and **warm pools are never shared across tenants**. **Secrets** (`SecretProvider`) are per-tenant.
- **Budgets** (`BudgetTracker`, `@everdict/domain`) — per-tenant `{usd, tokens, runs}` admission
  (`PaymentRequiredError` 402) + cost accounting. **Autoscaler** (`@everdict/domain`) — grows/shrinks capacity from queue depth.
- **HTTP surface** (`apps/api`, Fastify) — async `POST /runs` → run-id, `GET /runs/:id` poll, optional webhook; batch
  **scorecards** (dataset×harness → `Scorecard`+summary, `GET /scorecards/diff` baseline↔candidate, push/pull trace
  ingest, `GET /scorecards/leaderboard`, cron **schedules** on Temporal), **bundles** (`POST /bundles/apply`), workspace
  **integrations** (GitHub App + Mattermost) + **runners**, CI triggers; stores: `RunStore` + `ScorecardStore` (in-memory or `Pg*`
  on Postgres via `DATABASE_URL`). Full **BFF↔MCP parity** (`/mcp`). See `docs/api.md` + `docs/mcp.md` +
  `docs/scorecards.md`.
- **Registry** (`@everdict/registry`) — the version SSOT for **harness templates + instances · datasets · judges ·
  rubrics · models · agents · runtimes · environments · benchmarks**: `(tenant, id, version)` (immutable versions,
  semver `latest`, tenant-owned + `_shared` fallback; in-memory / file-GitOps / `Pg*` on Postgres).
  `ServiceTopologyBackend`'s `specFor` resolves a job's `{id, version}` reference to a concrete spec at dispatch.
  See `docs/registry.md` + `docs/datasets.md` + `docs/judges.md` + `docs/runtimes.md` + [harness-taxonomy.md](harness-taxonomy.md).
- **Auth core** (`@everdict/auth`, consumed by `apps/api`) — every credential resolves to a `Principal{subject,
  workspace, roles, via}`: OIDC/Keycloak JWT (verified via `jose` JWKS) for humans, API keys (`ak_…`) for
  agents/MCP/CI, plus runner, GitHub Actions and agent tokens, behind one `compositeAuthenticator`.
  `workspace = tenant = trust-zone`; a role→action matrix (`viewer/member/admin`, `@everdict/domain`) gates every
  route. The web is a token courier, **not** an auth authority. See `docs/auth.md`.
- **Tenant access + human surfaces** — tenant-owned entities and workspace-scoped reads (`docs/tenancy.md`); the
  `apps/web` Next.js dashboard (Keycloak user login, `/{workspace}/…`) is a pure HTTP client of the control
  plane (`docs/web.md`), and the `apps/desktop` Electron shell renders that same web (parity by construction)
  while embedding the self-hosted runner ([desktop-app.md](desktop-app.md)). Humans → Keycloak; agents → API keys.
- **Owner runtime** — `apps/agent`, Everdict's own agent over `@everdict/agent-runtime`, consumes the trust
  harness and is not part of it.

## Cross-cutting
- Cost/token capture comes from the harness trace (e.g. Claude's `total_cost_usd` in stream-json); the same
  trace cost feeds per-tenant budgets (`sumCost`).
- External/orchestrator failures are remapped to `AppError` (never propagated raw); HTTP maps `AppError.status`.
- Durable dispatch+await is implemented via `@everdict/orchestrator` (Temporal): a worker runs the
  `dispatchCase` activity (a `Dispatcher` — the capacity-aware `Scheduler` → backend); the client starts/awaits a
  workflow. See `docs/orchestration.md`.
