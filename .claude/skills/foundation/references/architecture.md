# Architecture reference

## Packages
| Package | Role | Depends on |
|---|---|---|
| `@everdict/core` | contracts: interfaces + Zod schemas + errors | (none) |
| `@everdict/drivers` | `Driver` impls — in-sandbox compute (Local) | core |
| `@everdict/environments` | `Environment` impls — the world acted on (Repo) | core |
| `@everdict/harnesses` | `EvaluableHarness` impls — the agent under test | core |
| `@everdict/graders` | `Grader` impls — scoring | core |
| `@everdict/runner` | the eval loop (`runCase`) | core, drivers, environments, harnesses, graders |
| `@everdict/agent` | dispatched unit: a self-contained worker that runs runCase inside a job, emits result | core, runner, drivers, environments, harnesses, graders |
| `@everdict/backends` | `Backend` impls (+ `capacity()`) — placement (Local, Nomad; K8s/Windows later) + `Router` (static) / `Scheduler` (capacity-aware + queue) / `BackendRegistry` | core, agent |
| `@everdict/orchestrator` | durable control plane (Temporal): Direct/Temporal orchestrators + worker | core, backends, agent |
| `@everdict/trace` | pull a harness trace from OTel/MLflow → `TraceEvent` | core |
| `@everdict/topology` | service-topology harnesses: `ServiceTopologyBackend` + Nomad/K8s builders + env manager | core, backends, graders, trace |
| `@everdict/suite` | suites + version regression: `runSuite` / `summarizeScorecard` / `diffScorecards` | core |
| `apps/cli` | dev control plane (`everdict run`, `everdict worker`, `everdict suite`) | core, agent, backends, orchestrator, suite |
| `@everdict/db` | result store: `RunStore` (`InMemoryRunStore`/`PgRunStore`) + numbered SQL migrations + `migrate`/`preflight` | core |
| `@everdict/registry` | harness version SSOT: `(id, version)→HarnessSpec`, immutable versions, file/GitOps loader + `PgHarnessRegistry` | core, db |
| `apps/api` | multi-tenant control-plane HTTP (Fastify): API-key auth + tenant-owned harnesses + async `POST /runs`/poll/webhook + `RunStore` | core, agent, backends, db, registry |
| `apps/web` | SaaS web (Next.js 16 FSD, Tailwind v4 + shadcn Toss-style): Keycloak login + per-tenant dashboard | (HTTP client of apps/api; no `@everdict/*` deps) |
| `@everdict/registry` | harness versioning | (planned) |

## The eval loop (runs inside the agent)
```
runCase(case, { driver, environment, harness, graders, runCtx }):
  compute = driver.provision({ os, image, needs })
  try:
    environment.seed(compute, case.env)        # known initial state
    harness.install(compute)
    trace = []; for ev in harness.run(compute, case.task, runCtx): trace.push(ev)
    snapshot = environment.snapshot(compute)
    scores = await all(graders.map(g => g.grade({case, trace, snapshot, compute})))
    return { caseId, harness:`${id}@${version}`, trace, snapshot, scores }
  finally:
    compute.dispose()
```

## Distributed execution: Backend (placement) vs Driver (in-sandbox)
The control plane (outside the clusters) builds an `AgentJob` (`{evalCase, harness:{id,version}}`)
and calls `Backend.dispatch(job)`. The Backend dispatches the **runner-agent** (`@everdict/agent`)
into an isolated unit; the agent reconstructs the harness+graders from a registry
(`makeHarness`/`makeGraders`; graders carry config via `GraderSpec`), runs the eval loop above via
`LocalDriver`, and prints the `CaseResult` behind the `__EVERDICT_RESULT__` sentinel; the Backend
parses it. Isolation is the orchestrator's (Nomad task `runtime` / K8s `runtimeClassName` /
Windows VM), not Everdict's. Backends: `LocalBackend` (in-process dev), `NomadBackend` (batch alloc;
phase 1), `K8sBackend` + `WindowsBackend` (later). See skill `backends` + `docs/execution-backends.md`.

Fan out cases × harness-versions; regression = run a suite against `harness@vA` and `@vB`, diff
scorecards. Durable dispatch+await is implemented in `@everdict/orchestrator` (Temporal):
`evalCaseWorkflow`/`suiteWorkflow` call the `dispatchCase` activity (which runs a `Dispatcher`); the
`everdict worker` holds the registry + a capacity-aware `Scheduler` (gates on `Backend.capacity()`,
queues when full, backpressure via `RateLimitError`), the client (`everdict run --orchestrator temporal`)
starts+awaits. `suiteWorkflow` fan-out is bounded. See `docs/orchestration.md` + `docs/execution-backends.md`.

## How new things plug in (no core rewrite)
- New compute target (Nomad / K8s / Windows pool) → new `Backend`; the agent + loop are unchanged.
- New OS env on a pool (Windows/macOS) → `Backend` + per-run VM-checkpoint isolation.
- New env type (browser / os-use) → new `Environment` + `EnvSnapshot` variant + grader family.
  os-use adds a `Computer` capability (screenshot/click/type) to `ComputeHandle` + a desktop image.
- New harness (Codex / LangGraph) → new `EvaluableHarness` adapter (+ a registry entry in `@everdict/agent`).
- New scoring signal → new `Grader` (+ a registry entry). Grader is the one scoring primitive (a model-backed
  Grader = an Agent Judge); the automatic passRate/mean summary needs no definition.

## Build status & order
Built: core → drivers(Local) → environments(Repo) → harnesses(claude-code/scripted) →
graders(tests-pass/cost/steps/latency) → runner → agent → backends(Local/Nomad) + Router/Registry →
orchestrator(Direct/Temporal + worker) → cli (`run`/`worker`).
Service-topology harnesses (browser-use-langgraph etc.): `@everdict/trace` (OTel/MLflow → TraceEvent) +
`@everdict/topology` (HarnessSpec(service), orchestrator-agnostic `ServiceTopologyBackend`, Nomad+K8s builders,
runId-keyed isolation) — Phase 1 built+tested; live runtimes/browser+ext provisioning = Phase 2. See
`docs/service-harness.md`.
Next: live TopologyRuntimes (Nomad/K8s apply) + browser+extension provisioning + real OTel/MLflow; process
`K8sBackend`/`WindowsBackend`; suite/version-regression; `registry`, apps/api, Postgres/ClickHouse, deploy, dashboard.
