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
`--orchestrator`, `--backends-config`, …): it dispatches each case via the chosen orchestrator and
aggregates into a Scorecard + a per-metric summary.

## API (`@everdict/application-control`)
- `runSuite(suite, version, dispatch, {concurrency})` → `Scorecard`. `dispatch` is any
  `(job) → CaseResult` (a `Backend` / `Router` / `Orchestrator`).
- `summarizeScorecard(sc)` → per-metric `{count, mean, passRate}`.
- `diffScorecards(baseline, candidate)` → `{metrics[], regressions[], improvements[]}`. Regressions/
  improvements are detected by **objective `pass` transitions** (true→false = broke, false→true = fixed);
  numeric metrics (cost/steps) report a delta without assuming a direction.

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
