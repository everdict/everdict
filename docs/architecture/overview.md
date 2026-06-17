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
- metric → new `Grader` (+ registry entry).

## Cross-cutting
- Cost/token capture comes from the harness trace (e.g. Claude's `total_cost_usd` in stream-json).
- External/orchestrator failures are remapped to `AppError` (never propagated raw).
- Durable dispatch+await is implemented via `@assay/orchestrator` (Temporal): a worker runs the
  `dispatchCase` activity (Router → backend); the client starts/awaits a workflow. See `docs/orchestration.md`.
