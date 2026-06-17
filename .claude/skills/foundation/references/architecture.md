# Architecture reference

## Packages
| Package | Role | Depends on |
|---|---|---|
| `@assay/core` | contracts: interfaces + Zod schemas + errors | (none) |
| `@assay/drivers` | `Driver` impls — where a run executes | core |
| `@assay/harnesses` | `EvaluableHarness` impls — the agent under test | core |
| `@assay/graders` | `Grader` impls — scoring | core |
| `@assay/runner` | the eval loop, Temporal-orchestrated | core, drivers, harnesses, graders, registry |
| `@assay/registry` | harness version management | core |
| `apps/api` | Fastify control plane | runner, registry, core |

## The eval loop (runner)
```
runCase(case, harness, driver, environment, graders, runCtx):
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
Fan out cases × harness-versions; each `runCase` is a Temporal activity (retry/resume).
Regression = run a suite against `harness@vA` and `@vB`, diff scorecards.

## How future requirements plug in (no core rewrite)
- New OS (Windows/macOS) → new `Driver` (Pool driver: runner-agent + VM checkpoint). Loop unchanged.
- New env type (browser / os-use) → new `Environment` + `EnvSnapshot` variant + grader family.
  os-use adds a `Computer` capability (screenshot/click/type) to `ComputeHandle` + a desktop image.
- New harness (Codex / LangGraph) → new `EvaluableHarness` adapter.
- New metric → new `Grader`.

## v1 slice (build order)
core → drivers/e2b-linux → harnesses/claude-code → graders/tests-pass(+cost/steps/latency) → runner → apps/api.
Then Temporal, Postgres (Drizzle), ClickHouse, deploy (Helm/K8s), version regression, dashboard.
