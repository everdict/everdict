---
kind: wiki
title: "Trial-based verdict — pass@k, flakiness & statistical regression"
status: current
updated: 2026-09-15
anchors: [packages/domain/src/scorecard/trials.ts, packages/application-control/src/run-suite.ts, packages/domain/src/scorecard/gate.ts]
---
# Trial-based verdict — pass@k, flakiness & statistical regression

How Everdict turns *N repeated trials of a case* into a verdict instead of a single noisy pass/fail.

## Why

A single run of an agent case is a coin flip: the same harness on the same case can pass once and fail
the next time (non-determinism in the model, the environment, timeouts, tool flakiness). A scorecard
built from one run per case reports **noise as signal**, and a version diff off two single runs flags
"regressions" that are just variance.

The eval literature's answer is to run each case **N times** and report:
- **pass@k** — the unbiased probability that a size-`k` sample of the N trials contains ≥1 pass
  (Chen et al., 2021, *Evaluating LLMs Trained on Code*). `pass@1` = the mean per-case pass rate.
- **flakiness** — a case that both passes and fails across its trials (`0 < passes < trials`).
- **a statistical regression gate** — a case counts as regressed only when the drop in pass rate is
  beyond sampling noise, not on a single pass→fail flip.

## Data model — trials are repeated CaseResults

A trial is one execution of a case. There is no separate aggregate wire type: `CaseResult` carries an
optional **`trial`** index (`packages/contracts/src/execution/eval-case.ts`).

- `trial` absent = a single-run case; every single-run scorecard, ingest path and child run is unchanged.
- `trial: 0..N-1` = the i-th repetition. `Scorecard.results` holds N entries with the same `caseId`,
  distinguished by `trial`.

Aggregation groups results by `caseId`; each trial's verdict is the existing authority-ranked `caseVerdict`
(ground-truth > objective > judge), judged under the batch's own stamped verdict policy.

## Where trials come from

- **Live batches** — `trials` (1–100) on `POST /scorecards` and MCP `run_scorecard`
  (`apps/api/src/api/scorecard/request/run-scorecard.ts`). `runSuite`
  (`packages/application-control/src/run-suite.ts`) fans each case into one job per `(case, trial)`, each
  carrying its trial index; `trials=1` leaves `trial` unset. A resumed batch skips the `(case, trial)` pairs
  that already committed.
- **Ingested batches** — repeated `caseId`s in an upload ARE trials; `ScorecardIngestService` stamps the
  occurrence index so the same machinery engages
  (`packages/application-control/src/scorecard/scorecard-ingest-service.ts`).

## Pure math (`packages/domain/src/scorecard/trials.ts`)

All pure, no I/O.

- `passAtK(n, c, k)` — unbiased estimator `1 - C(n-c, k)/C(n, k)` in the numerically stable product form.
  `k` is clamped to `n`. Throws `BadRequestError` on non-integers, `n<=0`, `c∉[0,n]`, `k<=0`.
- `groupTrials(sc)` — `Map<caseId, CaseResult[]>`, insertion-ordered.
- `caseTrialStats(caseId, results, policy?)` — `{ trials, passes, passRate, flaky }`, counting only trials
  whose `caseVerdict` is defined.
- `summarizeTrials(sc, { k?, policy? })` — `{ cases, minTrials, maxTrials, passAt1, k, passAtK, flakyCases,
  flakeRate }`. `passAt1`/`passAtK` are **means over cases** (each case weighted once). `k` defaults to
  `minTrials` — the honest ceiling every case actually reached.
- `diffTrials(baseline, candidate, { zThreshold?, minDelta?, fdrAlpha?, baselinePolicy?, candidatePolicy? })`
  — the statistical regression gate. Per shared case:
  - significance is **Fisher's exact test** (`fisherExactTwoSided`) while either side has fewer than
    `FISHER_MAX_TRIALS` (30, `packages/contracts/src/records/evolution-campaign.ts`) trials, else a
    two-proportion z-test at `zThreshold` (default `1.96`); each case records `method` and `p`;
  - a case is `significant` only when it is statistically significant AND `|delta| >= minDelta`
    (default `0`); a regression is significant with a drop, an improvement significant with a rise;
  - `fdrAlpha` applies a Benjamini–Hochberg correction (`benjaminiHochberg`) across the cases; a case that
    cleared its own alpha but not the correction is marked `fdrSuppressed`, not dropped;
  - each side is judged under its own policy, never re-judged under today's;
  - cases that cannot enter the test are enumerated in `missing` (`casesOnlyInBaseline`,
    `casesOnlyInCandidate`, `unscoredCases`), never silently dropped.

`diffScorecards` (case-verdict transitions) stays the single-run lens; for trial batches `diffTrials` is the
authoritative regression signal.

## Read surfaces

- **Scorecard detail** — `ScorecardRecord.trialSummary` (`ScorecardTrialSummarySchema`,
  `packages/contracts/src/records/scorecard.ts`) is DERIVED on read by `ScorecardBatch.withTrialSummary`
  (`packages/domain/src/scorecard/scorecard-batch.ts`), never persisted, present only on a multi-trial batch.
  A batch whose stamped policy cannot be restored gets no roll-up.
- **Diff** — `GET /scorecards/diff?baseline=&candidate=&z=` and MCP `diff_scorecards` attach a `trials` diff
  when either side has trials and both policies resolve
  (`packages/application-control/src/scorecard/scorecard-analytics-service.ts`).
- **Gate** — `POST /scorecards/gate` and MCP `gate_scorecards` accept `zThreshold`, `minDelta` and `fdrAlpha`
  on the policy (`GatePolicySchema`, `packages/contracts/src/records/gate.ts`); `evaluateGate` counts
  `trial_regression` reasons from the trials diff.
- **Web** — pass@1 / pass@k / flake rate / trial count on the scorecard detail
  (`apps/web/src/app/[workspace]/scorecard/[id]/page.tsx`), and the statistically-gated regression and
  improvement lists on the compare page (`apps/web/src/app/[workspace]/scorecards/compare/page.tsx`).

## Non-goals

- Adaptive/early-stopping trial counts (more trials only for flaky cases). N is fixed per batch.
- Bayesian / bootstrap intervals.
- pass^k (all-k-pass) and other estimators — added as pure functions beside `passAtK` when a benchmark
  needs them.
