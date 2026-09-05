---
paths: "packages/{domain,application-execution,application-control}/**"
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
  and the declaration is constitution-gated while the name is not. `sanitizeScore(score, producer)` enforces
  it at TWO seams, and they must answer alike: inside the job (`safeGrade`, against the runtime `Grader`
  class) and again where the control plane makes the result canonical (`sanitizeSubmittedResult`, called by
  `Run.succeed`/`fail`/`adopt` and — before the receipt digests the bytes — by the batch committer), because
  on the self-hosted lane the job ran on the producer's own machine. A producer may emit a
  `RESERVED_AUTHORITY_METRICS` name only if it OWNS it, and ownership is never granted by a declaration:
  first-party graders carry theirs on the CLASS, read from `BUILTIN_GRADER_OWNED_METRICS` so the settle —
  which holds only the case's `GraderSpec`s — reads the same table; `declaredOwnedMetrics` is the one
  spelling of what a spec's `metrics` may grant (never a constitutional name); only a judge may write into
  the `judge:` family — at the settle that is a judge the platform APPLIED (`SettleDeclaration.judges`, whose
  rows `applyJudges` REPLACES rather than appends beside a producer's), an inline judge the case declared, or a
  spec declaring judge authority (`declaredJudgeAuthority` — the code-judge wrapper does, on the spec it builds).
  WHICH declaration the settle checks is the run's own `caseSpec` when the row persists one, else the sealed
  plan's graders + selected judges the committer hands over (a batch child persists no case by design) — exactly
  one, never both, and none reads fail-CLOSED. A violation becomes an `invalid` row —
  visible, aggregated nowhere, unable to decide a case — never a silent rename; and an `invalid` row is
  terminal, so the second seam re-reading the first's output is a no-op and the receipt's digest holds.
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
- **A declaration is not part of the constitution until the decision function that consumes the measurement
  also consumes that declaration.** The verdict policy composes from the EFFECTIVE graders (`applyGradingPlan`
  has already put a run-time plan on every case), never from the request field that overrode them — a dataset
  declaring a metric observational must reach `evaluateVerdict`, or the fallback lets the metric it declared
  inert decide the case. Two cases declaring different semantics for one metric is a malformed evaluation
  definition, refused rather than resolved by declaration order (arch-review 21 P0-2).
- **History is not immutable if deleting the anchor changes what the next decision believes was "last time".**
  A released release refuses deletion AND content edits: the next release's baseline is resolved from the
  released rows that still exist, so removing one manufactures a bootstrap rather than failing a comparison
  (arch-review 21 P0-3).
- **Compare a persisted stamp under the stamp's OWN algorithm** (`digestsMatch` / `seriesContractStampHolds`),
  never `contentDigest(doc) === stamped`. Legacy stamps are FNV and history has to keep verifying; a direct
  comparison is fail-CLOSED, which is worse than it sounds — the guard does not miss, it accuses (arch-review
  21 P1).
- **One plan, consumed many times.** What a batch SEALED is read through `ExecutionPlan` (application-control)
  — the selection/harness verification, the model-document pins, the judge closure, the sealed-closure spec
  pin. An execution path asks the plan; it never re-reads `manifest.*` to rebuild the same thing. A facet with
  four hand-copied readers grows its next field in three of them, which is four of this review series' P0s;
  the ownership is certified by a source scan (TRUST-120), because reconstruction is not a type error.
- **absent, unreadable, unregistered, ambiguous and legacy are five different states.** Compressing them into
  one `undefined` weakens authority every time: a sealed harness that VANISHED is not a built-in, a nested ref
  whose document could not be read is not a verified one, and two ledger rows matching a plan is not a
  resolution. Where an artifact proves stronger knowledge existed, a later absence may not be reinterpreted as
  the weaker legacy state (arch-review 22).
- **Every mutable input that composed a decision is that decision's read-set.** A terminal transition that
  CASes only the convenient subset is an atomic WRITE, not an atomic DECISION: the release ship conditions on
  the issues it counted and the candidate it compared as well as the product's policy. Where an input has no
  row to fence (registry/settings-resolved contracts), the re-verify is LABELLED as a re-verify — implying
  the stronger guarantee is worse than stating the weaker one (arch-review 22 P0-1).
- **Constitutional authority belongs to the declaration artifact at its write boundary**, not to whichever
  transport later executes it. `ground_truth` on a run-time grading plan is gated at submit; the same
  declaration inside a dataset is gated at REGISTRATION, on every door (REST, MCP, bundle, benchmark import),
  because an immutable document cannot be re-approved by the schedule that runs it (arch-review 22 P0-2).
- **A decision token preserves both the semantic identity AND the mutation generations that keep it valid
  until commit.** A candidate is a row plus the judgment of that row (id + revision + plane digest + no live
  pass), not a timestamp — a re-score changes what was read while `created_at` stands still. A capability is a
  GENERATION, not an insert time — a revive (`deleted_at = NULL`) and a soft delete both change what a name
  resolves to and move no timestamp. Historical time does not establish mutation authority (arch-review 23).
- **Evidence is only meaningful together with the decision procedure that produced it.** An observation
  carries its observer's era (`CURRENT_STAGE_PARITY_VERSION`), and a gate counts only its own — a green from a
  weaker comparison is a green about a different question (arch-review 23 P1).
- **An authorization that leaves no artifact authorizes nothing.** A constitutional declaration (a grader
  declaring `ground_truth`) is gated where it is authored AND leaves a receipt naming the approved content,
  the metrics and the mode (`approved` · `platform_seed` · `legacy_attested`); submit refuses a declaration
  with no receipt, or whose receipt names different bytes. Otherwise "it is in the registry" becomes the
  evidence, which is a story about the past rather than an authorization (arch-review 23 P1).
- **Absence is not a legacy allowance.** An unsealed batch does not execute, a manifest with no era or no
  per-case seal does not execute, and a product with a NULL policy/definition digest cannot have a ship
  decided against it. Each of these used to pass its check by having nothing to check — "a record from before
  X" is a statement about our history, not a reason to run something whose identity nobody can state
  (arch-review 23, legacy sweep).
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
