---
paths: "packages/suite/**"
---
# Suite rules (push)

Batch evaluation + version regression over **any** backend. Pure functions over `Scorecard`; no I/O, no SDKs.
The deep domain model (scoring, judges, leaderboard, views) is in skill `evaluation`. See `docs/suites.md`.

- **`runSuite(dataset, harness, dispatch)`** fans each case through a `Dispatch` (`AgentJob → CaseResult`) — depend
  on that interface, not a concrete Backend/Scheduler. Per-case isolation: one case failing must not sink the batch.
- **Scoring is Grader-only.** `caseVerdict` derives per-case pass from `scores` by **authority rank**
  (ground-truth > objective > judge) — don't reinvent pass logic elsewhere. `summarizeScorecard` auto-emits
  `MetricSummary[]` (passRate/mean per `metric` label). The Metric(threshold) *entity* is gone; `Score.metric` as a
  **label** and the `metric` axis stay.
- **`diffScorecards(baseline, candidate)`** = pass transitions → regressions/improvements (the version-regression
  core). `trendSeries` (over time) + `scorecardModels`/leaderboard (`(harness × model)` rows, model axis) are the
  other read lenses — all pure, computed from stored `Scorecard`s.
- Keep this package free of orchestration (no run store, no scheduler) — the control plane wires those (rule `api-layer`).
