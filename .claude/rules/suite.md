---
paths: "packages/suite/**"
---
# Suite rules (push)

Batch evaluation + version regression over **any** backend. Pure functions over `Scorecard`; no I/O, no SDKs.
The deep domain model (scoring, judges, leaderboard, views) is in skill `evaluation`. See `docs/suites.md`.

- **`runSuite(dataset, harness, dispatch)`** fans each case through a `Dispatch` (`CaseJob → CaseResult`) — depend
  on that interface, not a concrete Backend/Scheduler. Per-case isolation: one case failing must not sink the batch.
- **An exception is not proof that a commit did not happen.** A store call that throws may have committed —
  a connection lost after Postgres wrote the row raises exactly like a failed insert. Compensation therefore
  needs evidence, not an error: read the row back, release only on authoritative ABSENCE, and HOLD on an
  unreadable store. "Unknown" is a third state, and holding is its fail-closed side (arch-review 19 P0-3).
- **A fallback is a new semantic decision.** It may not silently replace an identity the system previously
  knew exactly. The re-score's shell dataset (`task: ""`) is honest for a record that never had a registry
  dataset and catastrophic for one whose manifest sealed real case documents — the trace is genuine evidence,
  so an emptied question yields a real verdict nothing downstream can spot. Losing historical context is a
  reason to REFUSE, never to continue with less (arch-review 19 P0-2).
- **Authority is STAMPED, never inferred from a producer-controlled label.** A metric NAME assigns authority
  (`state`/`tests_pass` → ground_truth, `judge:<id>` → judge), so the name is as powerful as the declaration —
  and the declaration is constitution-gated while the name is not. `sanitizeScore(score, producer)` is the one
  boundary that enforces it: a producer may emit a `RESERVED_AUTHORITY_METRICS` name only if its spec DECLARED
  that authority, and only a judge may write into the `judge:` family. First-party graders carry their
  intrinsic authority on the CLASS (`readonly declaredAuthority`) so it cannot be lost by a call site that
  constructs one directly; a trusted builder that constructs a judge-shaped grader (the code-judge wrapper)
  declares it on the spec. A violation becomes an `invalid` row — visible, aggregated nowhere, unable to
  decide a case — never a silent rename.
- **Verification belongs at the read that produces the bytes actually used.** A pin checked where a document
  was RESOLVED says nothing about the read that materializes it later — the judge runner re-reads the rubric,
  the model and the delegated harness at use, and `JudgeAuthDispatcher` re-reads the runtime judge model at
  dispatch. Carry the pins to those seams and call the one decision function (`pinnedDocumentMismatch`) there;
  a check performed by another read is a check on a document nobody executed (arch-review 20 P0-4).
- **A constitutional name may not be granted by a declaration.** `isConstitutionalMetric` (contracts) owns the
  vocabulary the built-in ladder decides — the reserved authority metrics and the whole `judge:` family. A
  `GraderSpec` naming one is refused at submit with the alternative named, and `makeGraders` filters those
  names out of what a spec can hand a producer: declaring a name must never be the act that acquires the right
  to emit it (arch-review 20 P0-1).
- **A semantic capability must survive serialization unchanged.** One shape, one schema, wherever a document
  appears: the manifest, the pass and the revision share `SealedJudgeEntrySchema`, because a closure spelled
  three times grows its next field in two of them and the third reloads with nothing to verify against. A
  feature is not shipped until its production round trip carries it (arch-review 20 P0-3).
- **Coverage is not identity.** A cohort records how much of a batch reported it (`observed`/`total`) and keeps
  that out of its comparison key — a batch that lost a case to a dead dispatch did not move to another world
  (arch-review 20 P2).
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
