---
name: foundation
description: Read FIRST. Everdict's architecture, module boundaries, error model, naming and workflow conventions. Use whenever editing any package or starting a task.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Foundation

Everdict is a harness-agnostic, infra-agnostic **agent evaluation runtime**. Eval-first.

## Checklist before coding
1. Confirm which package you're in and its allowed dependencies (one-way, below).
2. If you touch a contract in `core`, update its Zod schema + the `core-contracts` skill in the same PR.
3. Use `AppError` for failures; remap any external/SDK error.
4. Run `pnpm format && pnpm lint && pnpm typecheck && pnpm test` before finishing.
5. Layout: `src/` is flat until ~15 non-test files, then grouped into domain subdirs (barrel + core contract at
   root, tests colocated). New file in a grouped package → put it in the matching domain subdir; adding one to a
   flat package that crosses ~15 files is the trigger to group it. Grouping keeps `index.ts`'s exports unchanged.

## Module dependency (one-way; reverse import = bug)
```
core ← { drivers · environments · harnesses · graders · trace } ← run-case ← agent ← backends ← { orchestrator · topology } ← { apps/cli · apps/api }
(self-hosted pull path)                                    agent · topology · trace  ← self-hosted-runner ← { apps/cli · apps/desktop }
```
- `core` — contracts only (interfaces + Zod + errors). No I/O, no SDK. Dependency root.
- `drivers` / `environments` / `harnesses` / `graders` — adapters; depend on `core` only.
- `runner` — the eval loop (`runCase`); composes adapters.
- `agent` — the dispatched unit: a self-contained worker that runs `runCase` over `LocalDriver` inside an isolated job, emits `__EVERDICT_RESULT__`.
- `backends` — placement + SaaS operational layer: `Backend.dispatch(AgentJob)` + `capacity()` → orchestrator (LocalBackend/NomadBackend; K8s/Windows later); `Router` (static) / `Scheduler` (capacity-aware + tenant-fair WFQ + quotas + backpressure) / `BackendRegistry`; `TrustZonePolicy` (per-tenant isolation), `SecretProvider`, `BudgetTracker`, `Autoscaler`.
- `orchestrator` — durable control plane (Temporal): `DirectOrchestrator` / `TemporalOrchestrator` + worker.
- `trace` — pull a harness trace from OTel/MLflow → `TraceEvent`. `topology` — service-topology harnesses
  (multi-service + target env): orchestrator-agnostic `ServiceTopologyBackend` + Nomad/K8s builders.
- `db` — result stores: `RunStore` (single runs) + `ScorecardStore` (batch evals; `list` omits heavy per-case results) + `ViewStore` (saved scorecard-analysis views, `private|workspace`) (`InMemory*`/`Pg*`) + numbered SQL migrations + idempotent `migrate`/`preflight`.
- `registry` — versioned SSOT (harnesses + datasets + judges + runtimes): `(tenant, id, version)→HarnessSpec` / `→Dataset` / `→JudgeSpec` / `→RuntimeSpec` (immutable versions, semver `latest`, tenant-owned + `_shared` fallback, file/GitOps loader); backs `ServiceTopologyBackend.specFor`. Datasets = harness-agnostic case bundles; Agent Judges = `model`|`harness`; Runtimes = local|nomad|k8s execution infra (`local` = dev/control-plane-host; "run on my machine" → self-hosted runner) (`docs/datasets.md`, `docs/judges.md`, `docs/runtimes.md`).
- `self-hosted-runner` — self-hosted runner core shared by CLI + desktop (MCP lease loop, resilient session, kind-branch execution). GUI-free, DI-style.
- `apps/cli` — dev control plane (`everdict run`, `everdict worker`, `everdict runner`).
- `apps/desktop` — Electron shell: renders deployed `apps/web` (web parity by construction) + resident runner. Skill `desktop`. `apps/api` — multi-tenant HTTP surface (Fastify): async `POST /runs`/poll/webhook + `RunStore` + workspace-owned harnesses/datasets/judges + async batch evals (`POST /scorecards`, dataset×harness→`Scorecard`) + agent-facing MCP (full BFF↔MCP parity). Postgres via `DATABASE_URL`.

## The spine: 4 in-sandbox concerns + 1 placement layer
Harness (under test) · Environment (the world it acts on) · Driver (where it runs *in-sandbox*) · Grader (how we judge).
A run = provision(Driver) → seed(Environment) → install+run(Harness)→trace → snapshot(Environment) → grade(Grader[]).
**Backend** (placement) wraps this: it dispatches the agent — which runs the above via
`LocalDriver` — to an orchestrator (Nomad/K8s/Windows) and parses the returned `CaseResult`.

## Topic map → references
- `references/architecture.md` — packages, the eval loop, Backend/agent, how new types plug in.
- `references/conventions.md`  — naming, error model, null discipline, language policy, commits.
- Contracts in detail → skill `core-contracts`. Adapters → skills `drivers` / `harnesses` / `graders`.
- Distributed execution → skill `backends` (Backend vs Driver, AgentJob).

## Critical rules (also pushed via .claude/rules)
- No `any` / no `!` / no silent nullable defaults; Zod-validate boundaries.
- Interfaces live in `core` (deliberate inversion of the single-impl no-interface rule — Everdict is a plugin runtime).
- Cost is read from the harness trace (Claude reports `total_cost_usd`); LocalDriver uses the machine's `claude` login (no API key).
- Backends never run the harness — they dispatch the `@everdict/agent` image and parse its `__EVERDICT_RESULT__` output.
