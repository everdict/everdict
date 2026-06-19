# Scorecards (batch eval: dataset × harness → aggregated result)

A **scorecard run** evaluates a whole **dataset** (N cases) against one `harness@version` and aggregates the
per-case results into a `Scorecard` + a per-metric `summary`. It's the eval payoff — the second step of the
pipeline and the input to baseline comparison (next increment):

```
Dataset → [scorecard run] → trace → agent-judge → scorecard → dashboard / baseline-compare
```

## How it works (`apps/api` `ScorecardService`)
1. Resolve the **dataset** (`DatasetRegistry`, owner-first/`_shared` fallback) → its cases. Missing → `404`.
2. Resolve the **harness version** (`latest → concrete`) via the registry; embed the `HarnessSpec` for
   declarative harnesses (builtins fall back to id). The record stores the **resolved** `harness@version`.
3. Build a `Suite` on the fly (`{ id: dataset.id, harness: { id }, cases }`) and run it with `@assay/suite`'s
   `runSuite` over the **same dispatcher** single runs use — each case becomes one job (tenant + budget
   admit/settle per case, concurrency-limited).
4. Aggregate with `summarizeScorecard` → store `{ status, summary, scorecard }`.

Runs are **async**: submit returns a `queued` record; poll until terminal. Normal eval failures produce
`CaseResult`s (the batch still succeeds); only infra/budget errors fail the whole run.

## Storage (`@assay/db`)
`ScorecardStore` (`InMemoryScorecardStore` / `PgScorecardStore`), mirror of `RunStore`. `ScorecardRecord` =
`{ id, tenant, dataset:{id,version}, harness:{id,version}, status, summary?, scorecard?, error?, …}`. **`list`
omits the heavy `scorecard`** (traces) — only `summary` — so the list is cheap; `get` returns the full record.
Migration: `packages/db/migrations/0006_create_scorecards.sql`.

## BFF ↔ MCP parity
| HTTP route | MCP tool | Action |
|---|---|---|
| `POST /scorecards` `{dataset, harness, judges?}` → 202 | `run_scorecard` | `scorecards:run` (member+) |
| `GET /scorecards` (summary only) | `list_scorecards` | `scorecards:read` (viewer+) |
| `GET /scorecards/:id` (full) | `get_scorecard` | `scorecards:read` |
| `GET /scorecards/diff?baseline=&candidate=` | `diff_scorecards` | `scorecards:read` |

Optional `judges:[{id,version?}]` applies registered **Agent Judges** to each case's trace after the run →
`judge:<id>` scores in the summary (control-plane, trace-based). See `docs/judges.md`.

All workspace-scoped (other-workspace `get` → `404`/`NOT_FOUND`), one service core, one auth core. See
`docs/api.md`, `docs/mcp.md`, `docs/web.md`, `docs/datasets.md`, `docs/suites.md`.

## Web (`apps/web`)
- **스코어카드 `/dashboard/scorecards`** — runs list (dataset@v → harness@v, status, per-metric summary chips).
- **상세 `/dashboard/scorecards/[id]`** — status, meta, per-metric **stat cards** (mean + pass-rate), per-case
  scores, error.
- **실행 `/dashboard/scorecards/new`** — pick dataset + harness (datalist) + optional judges → `runScorecardAction`
  → `POST /scorecards`. Role-gated off `/me` (`scorecards:run` = member+).
- **비교 `/dashboard/scorecards/compare?baseline=&candidate=`** — pick two succeeded scorecards → per-metric
  mean Δ table + **regressions (pass→fail) / improvements (fail→pass)** via `diffScorecards`. This is the
  baseline-vs-candidate payoff. `scorecards:read`.
