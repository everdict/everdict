# Architecture reference

## Packages
| Package | Role | Depends on |
|---|---|---|
| `@assay/core` | contracts: interfaces + Zod schemas + errors | (none) |
| `@assay/drivers` | `Driver` impls — in-sandbox compute (Local) | core |
| `@assay/environments` | `Environment` impls — the world acted on (Repo) | core |
| `@assay/harnesses` | `EvaluableHarness` impls — the agent under test | core |
| `@assay/graders` | `Grader` impls — scoring | core |
| `@assay/runner` | the eval loop (`runCase`) | core, drivers, environments, harnesses, graders |
| `@assay/agent` | dispatched unit (model B): runs runCase inside a job, emits result | core, runner, drivers, environments, harnesses, graders |
| `@assay/backends` | `Backend` impls (+ `capacity()`) — placement (Local, Nomad; K8s/Windows later) + `Router` (static) / `Scheduler` (capacity-aware + queue) / `BackendRegistry` | core, agent |
| `@assay/orchestrator` | durable control plane (Temporal): Direct/Temporal orchestrators + worker | core, backends, agent |
| `@assay/trace` | pull a harness trace from OTel/MLflow → `TraceEvent` | core |
| `@assay/topology` | service-topology harnesses: `ServiceTopologyBackend` + Nomad/K8s builders + env manager | core, backends, graders, trace |
| `@assay/suite` | suites + version regression: `runSuite` / `summarizeScorecard` / `diffScorecards` | core |
| `apps/cli` | dev control plane (`assay run`, `assay worker`, `assay suite`) | core, agent, backends, orchestrator, suite |
| `apps/api` | multi-tenant control-plane HTTP (Fastify): async `POST /runs`/poll/webhook + `RunStore` | core, agent, backends |
| `@assay/registry` | harness versioning | (planned) |

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

## Distributed execution: Backend (placement) vs Driver (in-sandbox) — model B
The control plane (outside the clusters) builds an `AgentJob` (`{evalCase, harness:{id,version}}`)
and calls `Backend.dispatch(job)`. The Backend dispatches the **runner-agent** (`@assay/agent`)
into an isolated unit; the agent reconstructs the harness+graders from a registry
(`makeHarness`/`makeGraders`; graders carry config via `GraderSpec`), runs the eval loop above via
`LocalDriver`, and prints the `CaseResult` behind the `__ASSAY_RESULT__` sentinel; the Backend
parses it. Isolation is the orchestrator's (Nomad task `runtime` / K8s `runtimeClassName` /
Windows VM), not Assay's. Backends: `LocalBackend` (in-process dev), `NomadBackend` (batch alloc;
phase 1), `K8sBackend` + `WindowsBackend` (later). See skill `backends` + `docs/execution-backends.md`.

Fan out cases × harness-versions; regression = run a suite against `harness@vA` and `@vB`, diff
scorecards. Durable dispatch+await is implemented in `@assay/orchestrator` (Temporal):
`evalCaseWorkflow`/`suiteWorkflow` call the `dispatchCase` activity (which runs a `Dispatcher`); the
`assay worker` holds the registry + a capacity-aware `Scheduler` (gates on `Backend.capacity()`,
queues when full, backpressure via `RateLimitError`), the client (`assay run --orchestrator temporal`)
starts+awaits. `suiteWorkflow` fan-out is bounded. See `docs/orchestration.md` + `docs/execution-backends.md`.

## How new things plug in (no core rewrite)
- New compute target (Nomad / K8s / Windows pool) → new `Backend`; the agent + loop are unchanged.
- New OS env on a pool (Windows/macOS) → `Backend` + per-run VM-checkpoint isolation.
- New env type (browser / os-use) → new `Environment` + `EnvSnapshot` variant + grader family.
  os-use adds a `Computer` capability (screenshot/click/type) to `ComputeHandle` + a desktop image.
- New harness (Codex / LangGraph) → new `EvaluableHarness` adapter (+ a registry entry in `@assay/agent`).
- New metric → new `Grader` (+ a registry entry).

## Build status & order
Built: core → drivers(Local) → environments(Repo) → harnesses(claude-code/scripted) →
graders(tests-pass/cost/steps/latency) → runner → agent → backends(Local/Nomad) + Router/Registry →
orchestrator(Direct/Temporal + worker) → cli (`run`/`worker`).
Service-topology harnesses (browser-use-langgraph etc.): `@assay/trace` (OTel/MLflow → TraceEvent) +
`@assay/topology` (HarnessSpec(service), orchestrator-agnostic `ServiceTopologyBackend`, Nomad+K8s builders,
runId-keyed isolation) — Phase 1 built+tested; live runtimes/browser+ext provisioning = Phase 2. See
`docs/service-harness.md`.
Next: live TopologyRuntimes (Nomad/K8s apply) + browser+extension provisioning + real OTel/MLflow; process
`K8sBackend`/`WindowsBackend`; suite/version-regression; `registry`, apps/api, Postgres/ClickHouse, deploy, dashboard.
