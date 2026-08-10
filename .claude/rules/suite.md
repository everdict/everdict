---
paths: "packages/suite/**"
---
# Suite rules (push)

Batch evaluation + version regression over **any** backend. Pure functions over `Scorecard`; no I/O, no SDKs.
The deep domain model (scoring, judges, leaderboard, views) is in skill `evaluation`. See `docs/suites.md`.

- **`runSuite(dataset, harness, dispatch)`** fans each case through a `Dispatch` (`CaseJob → CaseResult`) — depend
  on that interface, not a concrete Backend/Scheduler. Per-case isolation: one case failing must not sink the batch.
- **Authority is STAMPED, never inferred from a producer-controlled label.** A metric NAME assigns authority
  (`state`/`tests_pass` → ground_truth, `judge:<id>` → judge), so the name is as powerful as the declaration —
  and the declaration is constitution-gated while the name is not. `sanitizeScore(score, producer)` is the one
  boundary that enforces it: a producer may emit a `RESERVED_AUTHORITY_METRICS` name only if its spec DECLARED
  that authority, and only a judge may write into the `judge:` family. First-party graders carry their
  intrinsic authority on the CLASS (`readonly declaredAuthority`) so it cannot be lost by a call site that
  constructs one directly; a trusted builder that constructs a judge-shaped grader (the code-judge wrapper)
  declares it on the spec. A violation becomes an `invalid` row — visible, aggregated nowhere, unable to
  decide a case — never a silent rename.
- **Scoring is Grader-only.** `caseVerdict` derives per-case pass from `scores` by **authority rank**
  (ground-truth > objective > judge) — don't reinvent pass logic elsewhere. `summarizeScorecard` auto-emits
  `MetricSummary[]` (passRate/mean per `metric` label). The Metric(threshold) *entity* is gone; `Score.metric` as a
  **label** and the `metric` axis stay.
- **`diffScorecards(baseline, candidate)`** — TWO regression planes, one unit for release decisions:
  `caseTransitions` (case-VERDICT transitions, each side judged under its own stamped policy — the unit
  `evaluateGate` counts, same unit as `diffTrials`) and `regressions`/`improvements` (metric-level pass flips —
  DIAGNOSIS of why a case moved, never a gate's count). `trendSeries` (over time) + `scorecardModels`/leaderboard
  (`(harness × model)` rows, model axis) are the other read lenses — all pure, computed from stored `Scorecard`s.
- Keep this package free of orchestration (no run store, no scheduler) — the control plane wires those (rule `api-layer`).
