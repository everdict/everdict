# Architecture overview

Detailed conventions live in `.claude/skills/` (single source of truth). This file is the
human-facing map.

## The 4-way separation
| Concern | Interface (`@assay/core`) | v1 impl |
|---|---|---|
| Harness (under test) | `EvaluableHarness` | `claude-code` |
| Environment (world acted on) | `Environment<EnvSnapshot>` | `RepoEnvironment` |
| Driver (where it runs) | `Driver` / `ComputeHandle` | `E2BLinuxDriver` |
| Grader (how we judge) | `Grader` | `tests-pass`, `cost`, `steps`, `latency` |

## The eval loop
provision(Driver) → seed(Environment) → install+run(Harness)→normalized trace →
snapshot(Environment) → grade(Grader[]) → Scorecard. Each case run is a durable Temporal
activity; suites fan out over cases × harness versions; regression = diff two scorecards.

## Extension (no core rewrite)
- OS Win/macOS → new `Driver` (physical pool + runner-agent + VM checkpoint).
- env browser/os-use → new `Environment` + snapshot variant (+ a `Computer` capability for os-use).
- harness Codex/LangGraph → new `EvaluableHarness`.
- metric → new `Grader`.

## Cross-cutting
- Cost/token capture is harness-agnostic via the LLM proxy (`ANTHROPIC_BASE_URL` → LiteLLM).
- External failures are remapped to `AppError` (never propagated raw).
