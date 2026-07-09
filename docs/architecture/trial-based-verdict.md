# Trial-based verdict — pass@k, flakiness & statistical regression

> Status: **M1 in progress.** Slice 1 (contracts + pure aggregation math) landed; slices 2–5 follow.
> SSOT for how Everdict turns *N repeated trials of a case* into a **defensible verdict** instead of a
> single noisy pass/fail.

## Why

A single run of an agent case is a coin flip: the same harness on the same case can pass once and fail
the next time (non-determinism in the model, the environment, timeouts, tool flakiness). A scorecard
built from one run per case therefore reports **noise as signal** — and a version diff off two single
runs flags "regressions" that are just variance.

The eval literature's answer is to run each case **N times** and report:
- **pass@k** — the unbiased probability that a size-`k` sample of the N trials contains ≥1 pass
  (Chen et al., 2021, *Evaluating LLMs Trained on Code*). `pass@1` = the mean per-case pass rate;
  `pass@k` (k = trials) = "did the agent solve it at least once in k attempts".
- **flakiness** — a case that both passes and fails across its trials (`0 < passes < trials`).
- **statistical regression gate** — a case counts as regressed only when the drop in pass rate is
  beyond sampling noise (a two-proportion test), not on a single pass→fail flip.

This is the differentiator the market thesis calls out: a *verdict*, not another scoring dashboard.
Everdict = eval **+ verdict**; trials are what make the verdict defensible.

## Data model — trials are just repeated CaseResults

A trial is one execution of a case. We do **not** introduce a new aggregate wire type; instead a
`CaseResult` carries an optional **`trial`** index (`packages/core/src/execution/eval-case.ts`):

```
CaseResult { caseId, harness, trial?, trace, snapshot, scores, failure?, … }
```

- `trial` absent (or `0`) = a single-run case — **fully backward compatible**. Every existing
  scorecard, ingest path, and child run keeps working unchanged (each case has exactly one result).
- `trial: 0..N-1` = the i-th repetition. A `Scorecard.results` array may hold N entries with the same
  `caseId`, distinguished by `trial`. The child-run model already fans a case into an addressable
  `RunRecord`; trials extend that to **N children per case** (slice 2).

Aggregation groups results by `caseId`; the per-trial verdict reuses the existing authority-ranked
`caseVerdict` (ground-truth > objective > judge). Nothing about how a *single* trial is judged changes.

## Pure math (`packages/suite/src/trials.ts`) — slice 1

All pure, dependency-free, no I/O — same discipline as `scorecard.ts`/`leaderboard.ts`.

- `passAtK(n, c, k)` — unbiased estimator `1 - C(n-c, k)/C(n, k)`, computed in the numerically stable
  product form from the paper's reference code. `k` is clamped to `n` (pass@k with k>n is undefined →
  treated as pass@n). `pass@1 = c/n`. Throws `BadRequestError` on `n<=0`, `c∉[0,n]`, `k<=0`.
- `groupTrials(sc)` — `Map<caseId, CaseResult[]>`, insertion-ordered.
- `caseTrialStats(caseId, results)` — `{ trials, passes, passRate, flaky }`, counting only trials whose
  `caseVerdict` is defined (a case with no pass-deciding grader is excluded, same as `scorecardPassRate`).
- `summarizeTrials(sc, k?)` — scorecard roll-up `{ cases, minTrials, maxTrials, passAt1, k, passAtK,
  flakyCases, flakeRate }`. `passAt1`/`passAtK` are **means over cases** (each case weighted once,
  regardless of trial count). `k` defaults to `maxTrials`; per case it is clamped to that case's trials.
- `diffTrials(baseline, candidate, opts?)` — the **statistical regression gate**. Per shared case it
  runs a two-proportion z-test on `(passes/trials)` baseline vs candidate:
  `p̂=(c_b+c_c)/(n_b+n_c)`, `se=√(p̂(1-p̂)(1/n_b+1/n_c))`, `z=(p_c-p_b)/se`. A case is a **regression**
  only when `z ≤ -zThreshold` (default `1.96`, i.e. 95%) and the rate dropped; an **improvement** when
  `z ≥ +zThreshold` and it rose. Cases with zero scored trials on either side are skipped (can't compare).

`diffTrials` is the trial-aware sibling of `diffScorecards`; the single-run `diffScorecards`
(pass-transition based) is left untouched for `trials=1` batches.

## Slices

1. **Contracts + pure math** (this doc + `trials.ts` + tests) — `trial` on `CaseResult`; pass@k /
   flakiness / statistical diff. ✅ Green in `core` + `suite`, no wiring yet.
2. **`runSuite` N-trial fan-out** — a `trials` knob expands each case into N jobs (`trial` stamped);
   `ScorecardService` threads `trials` from `RunScorecardInput`, one child run per trial.
3. **Persist + read** — `ScorecardRecord` gains a lightweight `trialSummary` (like `summary`/`models`);
   `finalizeBatch`/`track` compute it; `GET /scorecards/:id` returns it.
4. **API/MCP parity** — `trials` param on `POST /scorecards` + `run_scorecard`; `GET /scorecards/diff`
   uses `diffTrials` when either side has trials; a `?statistical` opt-in on the gate.
5. **Web** — pass@k / flake-rate surfaced on the scorecard detail + diff, through the shared score atoms.

## Non-goals (for now)
- Adaptive/early-stopping trial counts (run more trials only for flaky cases). Fixed N first.
- Bayesian / bootstrap intervals. The normal-approx two-proportion test is the defensible first cut;
  swap the estimator behind `diffTrials` later without changing callers.
- pass^k (all-k-pass) and other estimators — add as pure fns beside `passAtK` when a benchmark needs them.
