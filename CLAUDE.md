# Assay — Agent Harness Evaluation Runtime

> Assay = "to assay": to determine the quality/composition of something.
> A **harness-agnostic, infra-agnostic** runtime that runs and **evaluates** arbitrary
> agent harnesses (Claude Code, Codex, LangGraph, …) across environments (repo / browser /
> os-use) and OSes (Linux / Windows / macOS). Eval-first; just enough operational runtime
> to drive long/stateful/isolated runs.

## 🚨 Documentation-first — read before you code
Always read the relevant skill in `.claude/skills/` **before** writing code. No exceptions.
Read the matching `<area>/SKILL.md` first, then pull `references/*.md` on demand.
`.claude/` is the **single source of truth** for how we build. (idiom from digo-api)

## Language policy (idiom carried from digo-api)
- `.claude/skills/` + `.claude/rules/` bodies → **English**.
- Code comments + OpenAPI `summary` → **Korean**.
- User-facing communication → **Korean**.

## Essential commands (run in this order)
1. `pnpm format`   — Biome format (always first)
2. `pnpm lint`     — Biome check (format + lint, single tool = ktlint reinterpretation)
3. `pnpm typecheck`— `tsc --noEmit` across packages (turbo)
4. `pnpm test`     — Vitest across packages (turbo)
5. `pnpm build`    — turbo build
Quality is non-negotiable: all five must pass before a PR.

## Architecture — one-way dependency, by concern (idiom from digo-api)
```
core ← { drivers · environments · harnesses · graders · trace } ← runner ← agent ← backends ← { orchestrator · topology · suite } ← apps/cli
```
- `packages/core`         — contracts only (interfaces + Zod schemas + errors). Dependency ROOT. No I/O, no SDKs.
- `packages/drivers`      — *in-sandbox compute* (`ComputeHandle`): LocalDriver (dev / inside the agent).
- `packages/environments` — the world a run acts on (`RepoEnvironment`: seed + git-diff snapshot).
- `packages/harnesses`    — the agent under test, driven over a process boundary (ClaudeCodeHarness, ScriptedHarness).
- `packages/graders`      — scoring, fully separate from the harness (tests-pass / cost / steps / latency).
- `packages/runner`       — the eval loop (`runCase`).
- `packages/agent`        — the dispatched unit (model B): runs `runCase` inside an isolated job, emits the result.
- `packages/backends`     — *placement* (`Backend`): dispatch the agent to an orchestrator (LocalBackend, NomadBackend; K8s/Windows later) + `Router` (static) / `Scheduler` (capacity-aware + tenant-fair WFQ + queue/backpressure) / `BackendRegistry` + `TrustZonePolicy` (per-tenant isolation: enforced hardened runtime + namespace + warm-pool keying) + `Autoscaler` (queue-depth elastic scaling) + `SecretProvider`/`BudgetTracker` (per-tenant key scoping + cost/run budgets).
- `packages/orchestrator` — durable control plane on Temporal: `DirectOrchestrator` / `TemporalOrchestrator` + the worker (workflow=deterministic, activity=`dispatchCase`).
- `packages/trace`        — pull a harness trace from OTel/MLflow → normalized `TraceEvent` (for service harnesses).
- `packages/topology`     — **service-topology** harnesses (multi-service + target env): `HarnessSpec(service)`, orchestrator-agnostic `ServiceTopologyBackend` + Nomad/K8s topology builders + runId-keyed env manager. See `docs/service-harness.md`.
- `packages/suite`        — suites + **version regression**: `runSuite` / `summarizeScorecard` / `diffScorecards` (over any backend). See `docs/suites.md`.
- `apps/cli`              — dev/single-run control plane (`assay run [--orchestrator temporal]`, `assay worker`).
- `apps/api`              — **multi-tenant control-plane HTTP surface** (Fastify): async `POST /runs` → run-id, `GET /runs/:id` poll, webhooks, `RunStore` (in-memory; Postgres/ClickHouse behind the interface). See `docs/api.md`. `packages/registry` is planned.
Reverse imports are bugs. The same concern name recurs per package (vertical slices).

### Two execution layers (Backend vs Driver) — model B
- **Backend** (`@assay/backends`) = *placement*: dispatch a runner-agent job to an orchestrator
  (Nomad/K8s/Windows) and return the `CaseResult`. Isolation = the orchestrator's runtime.
- **Driver** (`@assay/core`/`drivers`) = *in-sandbox compute*: the agent runs the harness via
  `LocalDriver` inside its already-isolated job. See `docs/execution-backends.md`.

### ⚠️ Deliberate deviation from digo-api: interfaces ARE used
digo-api bans interfaces for DI because it has exactly one implementation per concept.
Assay's *whole product* is pluggable adapters (many Backends / Drivers / Harnesses / Graders), so the
`core` contracts MUST be interfaces. This is the one digo idiom we intentionally invert —
everywhere else (null discipline, error model, naming, layering) we follow it.

## Critical rules (the non-default ones — see `.claude/rules/`)
- No `any`, no non-null `!`, no silent nullable defaults; validate every boundary with Zod.
- Errors: throw an `AppError` subclass (`@assay/core`); HTTP status derives from the subtype.
- External/SDK failures are remapped to our `AppError` (never propagated raw) so monitoring blames us, not the user. (digo idiom)
- Cost/tokens come from the harness's own trace (e.g. Claude reports `total_cost_usd`); for LocalDriver the harness uses the machine's existing login (no API key).
- `ComputeHandle` is always released in a `finally`.
- Backends never run the harness; they dispatch the `@assay/agent` image and parse its `__ASSAY_RESULT__` stdout sentinel.
- Temporal workflow code (`@assay/orchestrator` `workflows.ts`) MUST be deterministic — no I/O; side effects go in activities.

## Key principles
1. **Read first, code second — NO EXCEPTIONS.**
2. **Quality is non-negotiable** — format/lint/typecheck/test/build all green.
3. **Skills travel with the code** — a PR that changes a convention/invariant updates the matching skill reference *in the same PR* (mere implementation churn is not a doc trigger).
4. **Reinterpret, don't copy** — digo-api/digo-infra-dev idioms are reinterpreted for TS; cite the source idiom when non-obvious.

## Commits (idiom from digo-api / digo-infra)
Conventional Commits, scoped: `feat(drivers): ...`, `fix(runner): ...`. Body explains the *why*.
Every `fix:` ships a regression test that fails on the pre-fix code.
