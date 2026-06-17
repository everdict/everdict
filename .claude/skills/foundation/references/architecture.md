# Architecture reference

## Packages
| Package | Role | Depends on |
|---|---|---|
| `@assay/core` | contracts: interfaces + Zod schemas + errors | (none) |
| `@assay/drivers` | `Driver` impls — in-sandbox compute (Local, E2B) | core |
| `@assay/environments` | `Environment` impls — the world acted on (Repo) | core |
| `@assay/harnesses` | `EvaluableHarness` impls — the agent under test | core |
| `@assay/graders` | `Grader` impls — scoring | core |
| `@assay/runner` | the eval loop (`runCase`) | core, drivers, environments, harnesses, graders |
| `@assay/agent` | dispatched unit (model B): runs runCase inside a job, emits result | core, runner, drivers, environments, harnesses, graders |
| `@assay/backends` | `Backend` impls — placement (Local, Nomad; K8s/Windows later) | core, agent |
| `apps/cli` | control plane PoC (`assay run --backend …`) | core, agent, backends |
| `@assay/registry`, `apps/api` | harness versioning + Fastify control plane | (planned) |

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
scorecards. Durable dispatch+await (Temporal) is the cross-cutting next step.

## How new things plug in (no core rewrite)
- New compute target (Nomad / K8s / Windows pool) → new `Backend`; the agent + loop are unchanged.
- New OS env on a pool (Windows/macOS) → `Backend` + per-run VM-checkpoint isolation.
- New env type (browser / os-use) → new `Environment` + `EnvSnapshot` variant + grader family.
  os-use adds a `Computer` capability (screenshot/click/type) to `ComputeHandle` + a desktop image.
- New harness (Codex / LangGraph) → new `EvaluableHarness` adapter (+ a registry entry in `@assay/agent`).
- New metric → new `Grader` (+ a registry entry).

## Build status & order
Built: core → drivers(Local/E2B) → environments(Repo) → harnesses(claude-code/scripted) →
graders(tests-pass/cost/steps/latency) → runner → agent → backends(Local/Nomad) → cli.
Next: `K8sBackend` → `WindowsBackend` → Temporal (durable dispatch+await) + routing → registry,
apps/api, Postgres(Drizzle)/ClickHouse, deploy (Helm/K8s), dashboard.
