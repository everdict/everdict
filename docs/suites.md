---
kind: wiki
title: "Suites & version regression"
status: current
updated: 2026-09-15
anchors: [apps/cli/src/main.ts, packages/application-control/src/run-suite.ts, packages/contracts/src/execution/suite.ts, packages/contracts/src/wire/scorecard/scorecard-diff.ts]
---
# Suites & version regression

A **Suite** = a set of `EvalCase`s for one harness id. Run it against a harness **version** → a
`Scorecard`. Run the same suite against two versions and **diff** → a regression report.

## Run
```bash
everdict suite --suite suite.json --harness-version 1.0.0
# regression vs a saved baseline scorecard:
everdict suite --suite suite.json --harness-version 1.1.0 --baseline v1.0.0-scorecard.json
```
`everdict suite` works over any backend/orchestrator (same flags as `everdict run` — `--backend`,
`--orchestrator`, `--backends-config`, `--harness-spec`, …) plus `--concurrency N` (default 4): it dispatches
each case via the chosen orchestrator and prints `{scorecard, summary, diff?}` as JSON.

## API
- `runSuite(suite, version, dispatch, opts)` (`@everdict/application-control`) → `Scorecard`. `dispatch` is any
  `(job) → CaseResult` (a `Backend` / `Router` / `Orchestrator`); `opts` carries `concurrency`, `trials`,
  `retries`/`retryBackoffMs`, `signal` and `onResult`.
- `summarizeScorecard(sc)` (`@everdict/domain`) → per-metric `{metric, count, mean?, passRate?, distribution?,
  mode?, unmeasured?}`.
- `diffScorecards(baseline, candidate, opts?)` (`@everdict/domain`) → `{metrics[], regressions[], improvements[],
  caseTransitions[], metricCoverage[], missing, …}`.
  **`caseTransitions` is the release-regression unit**: the case-VERDICT transition (`broke|fixed|same|
  unmeasured`) over shared (case, trial) pairs, each side judged under its own stamped policy — the unit
  `evaluateGate` counts, and the same unit `diffTrials` gates statistically. `regressions[]`/`improvements[]`
  are metric-level `pass` flips (true→false = broke, false→true = fixed) — diagnosis of WHY a case moved,
  never a gate's count. Numeric deltas are read through the policy's declared direction; with none declared
  (the CLI passes no policy) the reading is `unknown`, never a sign guess.

## Suite file
```jsonc
{
  "id": "browse-basics",
  "harness": { "id": "browser-use-langgraph" },
  "cases": [
    {
      "id": "login",
      "env": { "kind": "browser", "startUrl": "https://app" },
      "task": "log in",
      "graders": [{ "id": "url-matches", "config": { "pattern": "/home$" } }],
      "timeoutSec": 300,
      "tags": []
    }
  ]
}
```
