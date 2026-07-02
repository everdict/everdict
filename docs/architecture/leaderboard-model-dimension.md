# Leaderboard — model as a first-class dimension (harness × model × benchmark)

> **Status: Slice 1 SHIPPED (code + gates green: format/lint/typecheck/test on suite·db·api). Slices 2–3 pending.**
> Decisions locked with the user:
> **(1) model source = observed-first (trace `llm_call.model`) + declared fallback (spec `model`), store both;
> (2) first view = per-benchmark leaderboard ranking (harness × model).**
>
> Like [scheduled-evals](./scheduled-evals.md), [self-hosted-runner](./self-hosted-runner.md) and
> [judge-placement-locality](./judge-placement-locality.md): **strict generalization, additive.** The unit of
> aggregation — a **`ScorecardRecord`** (dataset@v × harness@v × time, with a lightweight per-metric `summary`) —
> already exists and is reused verbatim. This work adds **one missing dimension (`model`)** to that record and a
> **ranking view** (`leaderboard`) on top of the same lightweight `list()` that `trendSeries` already consumes.

## Problem

A public leaderboard (SWE-bench, GAIA, …) shows: *for this benchmark, here are the harnesses/models ranked by
score.* Assay wants the same, self-serve, plus experiment tracking and cross-harness comparison — over **three
axes**:

- **benchmark (dataset)** — "how does harness A score on the benchmarks it ran?"
- **harness** — "harness A vs B on the shared benchmarks"
- **model** — "which LLM does harness A@vX actually use, and how does model choice move the score?"

Everything except **model** already exists (`Scorecard = dataset@v × harness@v`, `diffScorecards` for A-vs-B,
`trendSeries` for experiment-over-time, `summarizeScorecard` for per-metric pass rate). The one gap is that
**`model` is captured nowhere**: it lives only inside each trace as per-call `llm_call.model`
(`packages/core/src/trace.ts:18`) and as a spec input (`CommandHarnessSpec.model`,
`packages/core/src/harness-spec.ts:222`; judge `model`), neither of which survives into the aggregated record.

**Key insight — model is per-run, not per-harness-version.** The same `command` harness version can be re-pinned
to a different `model`; a `process` harness (Claude Code) uses the machine login and pins **no** model at all
(only the trace reveals what ran). So model must be **captured per scorecard run by observing the trace**, not
derived from the harness spec. This is why model is a run-derived tag, **not** a new registry entity.

## Current state — verified

- **`ScorecardRecord`** (`packages/db/src/scorecard-store.ts:36`) keys on `{dataset:{id,version}, harness:{id,version}}`
  + lightweight `summary: MetricSummary[]` + heavy `scorecard` (per-case, omitted from `list`). `harness.version`
  is the **resolved concrete** version (never `latest`) — `scorecard-service.ts:164`.
- **Trace carries the actual model** — `TraceEvent` `llm_call.model` (`core/src/trace.ts:18`). `CommandHarness`
  even synthesizes it from `spec.model` when proxying usage. This is the observed-model source of truth.
- **Declared model** — only `CommandHarnessSpec.model` (`harness-spec.ts:222`); `process`/`service` specs have
  none. Judge model is `ModelJudgeSpec.model` (separate axis — the *scorer*, not the harness-under-test).
- **Aggregation already lightweight-driven** — `trendSeries` (`packages/suite/src/trend.ts`) consumes a
  `TrendCard` that `ScorecardRecord` **structurally satisfies** (suite has no `db` dep). A leaderboard is the same
  pattern: rank instead of time-order.
- **Analytics that exist** — `summarizeScorecard` / `diffScorecards` / `trendSeries` / `scorecardPassRate`
  (`packages/suite/src/scorecard.ts` + `trend.ts`); web pages list / detail / **compare** / **trend**
  (`apps/web/.../scorecards/*`). **No** ranking/leaderboard view and **no** model column anywhere today.
- **Store filtering** — `ScorecardStore.list(tenant?)` filters by tenant only; trend/diff filter in the service.
  The leaderboard follows suit (filter+group in the service over `list`), no new store query in v1.

## Design

### 1. Capture `model` on the scorecard record (the enabler — Slice 1)

At **finalize** (`ScorecardService.track` for live runs, `finishIngest` for push/pull ingest) compute a small
`models` object from the completed `Scorecard` + the resolved harness spec, and store it on the record:

```ts
// @assay/suite (pure; core-only dep)
scorecardModels(sc: Scorecard, declared?: string): {
  observed: string[]   // distinct llm_call.model across all cases, sorted
  declared?: string    // spec-declared model (CommandHarnessSpec.model), else undefined
  primary?: string     // ranking key: most-frequent observed (tie → lexicographically first), else declared
}
```

- **observed** = ground truth of "what LLM did harness A actually use" (from the trace).
- **declared** = configured intent (from `spec.model`); lets the UI flag **declared ≠ observed** drift.
- **primary** = the single value the leaderboard groups on. Observed wins (real > configured); `declared`
  fallback covers harnesses whose traces omit model; both absent ⇒ `undefined` ⇒ grouped as **unknown** (honest,
  e.g. a Claude Code run with no model in its trace).

Stored as an additive `models jsonb` column on `assay_scorecards` (**mig 0028**), mirrored on
`ScorecardRecordSchema` and **kept in `list`** (it is light — the leaderboard needs it without the heavy
`scorecard`). Historical rows have `models = null` (⇒ primary unknown); backfill is a follow-up (derivable from
the stored `scorecard.results[].trace`).

`db` mirrors the shape as a Zod schema (`ScorecardModelsSchema`), exactly as it already mirrors
`MetricSummary` — `db` depends only on `core`, `suite` does the computation, the service passes the result to
`store.update` (validated at the Pg boundary).

### 2. Rank view — `leaderboard` (Slice 2)

```ts
// @assay/suite (pure; consumes the same lightweight card as trendSeries)
leaderboard(cards: LeaderboardCard[], opts: { datasetId, metric, harnessId?, model?, window?: "latest"|"best" })
  : { dataset, metric, rows: LeaderboardRow[] /* ranked desc by score */ }
// row: { harness:{id,version}, model?, scorecardId, createdAt, score, passRate, mean, runs }
```

- Filter to `status:succeeded` + `dataset.id` (+ optional `harness`/`model`).
- **Group by `harness.id@version × models.primary`**; collapse each group to one representative scorecard
  (`window=latest` default, `best` = highest score) with `runs` = group size.
- `score = summary[metric].passRate ?? mean` (same convention as `trendSeries`); `metric` is an explicit axis
  (like trend — no universal headline metric; the UI offers a dropdown of metrics present).
- Ranked descending by `score`. `LeaderboardCard` is structurally satisfied by `ScorecardRecord` (incl. `models`).

### 3. The three views (Slice 3, web)

- **Per-benchmark leaderboard** *(first)* — pick dataset + metric → ranked `harness × model` table. The
  SWE-bench-style board. "pinch run on codex" lands here as one row.
- **Harness-centric history** — pick harness A → its scorecards across all datasets + the model each version
  used (reuses `list` filtered by `harness.id`; model column from `models`).
- **Cross-harness compare** — existing `compare` (diff A↔B) + model shown per side; the leaderboard filtered to
  chosen harnesses covers the across-benchmarks case.

## Surface (BFF↔MCP parity + roles)

- **HTTP** — `GET /scorecards/leaderboard?dataset=&metric=&harness?=&model?=&window?=` → `Leaderboard`
  (static route, ordered before `:id` like `/diff` and `/trend`). `scorecards:read`, workspace-scoped.
- **MCP** — `leaderboard_scorecards` (same `ScorecardService.leaderboard` core).
- **Response additions** — `models` now present on every `ScorecardRecord` (list + get), so the existing
  `GET /scorecards`, `GET /scorecards/:id`, list/detail web pages surface model with no new endpoint.
- **Web** — new `/[workspace]/scorecards/leaderboard` (dataset+metric picker → ranked table, model badge,
  declared≠observed drift badge, link to each scorecard); model column added to list + detail + compare.

## Reuse vs new

| Piece | Status |
|---|---|
| `ScorecardRecord` / `summary` / `list` / `trendSeries` / `diffScorecards` / `caseVerdict` | **reused verbatim** |
| `ScorecardService.submit` + `track` + `finishIngest` pipeline | **reused** (add one finalize step) |
| `scorecardModels` (`@assay/suite`) + `ScorecardModelsSchema` (`@assay/db`) | **new** (Slice 1) |
| `models jsonb` column + mig 0028 + Pg read/write/list | **new** (Slice 1) |
| `leaderboard` (`@assay/suite`) + `ScorecardService.leaderboard` | **new** (Slice 2) |
| `GET /scorecards/leaderboard` + `leaderboard_scorecards` MCP + `scorecards:read` gate | **new** (Slice 2) |
| Leaderboard web page + model column on list/detail/compare | **new** (Slice 3) |

## Slices (pnpm gates green at each)

1. ✅ **Model capture** — `scorecardModels` (suite) + `ScorecardModelsSchema` + `models` on `ScorecardRecord`
   (db) + mig 0028 (additive `models jsonb`) + Pg read/write/**list** + wire into `track`/`finishIngest`. New
   runs record observed+declared+primary; `list`/`get` expose it. Tests: `models.test.ts` (6), extended
   `scorecard-store.test.ts` (models round-trip + list), `scorecard-service.test.ts` (observed capture on submit).
2. **Leaderboard core + surface** — `leaderboard` (suite) + `ScorecardService.leaderboard` +
   `GET /scorecards/leaderboard` + `leaderboard_scorecards` MCP + `scorecards:read` gate. Rank harness×model on a
   dataset. *(Service unit-tested with fake store; BFF↔MCP parity.)*
3. **Web** — leaderboard page (dataset+metric picker → ranked table + model/drift badges) + model column on
   list/detail/compare.

## Decisions / non-goals

- **Model source = observed-first + declared fallback, store both (locked).** Lets the board rank by what
  actually ran while surfacing config drift; `unknown` when a trace omits model and no spec declares one.
- **Model is a run-derived tag, not a registry entity.** Models are external identifiers (`claude-opus-4-8`,
  `gpt-4`), not versioned SSOT like harnesses/datasets/judges. No `ModelRegistry`.
- **Metric is an explicit ranking axis** (parity with `trendSeries`) — no assumed universal headline metric.
- **Judge model is a separate axis** — `models` is the harness-under-test's LLM, not the scorer's. (A judge-model
  breakdown, if wanted, is a later, separate cut.)
- **Backfill of historical `models`** is a follow-up (derivable from the stored `scorecard.results[].trace`); v1
  populates on new runs and shows `unknown` for old ones.
- **Store-level model/dataset filters** deferred — the leaderboard filters+groups in the service over the
  lightweight `list`, exactly as trend/diff already do; add SQL filters only if `list` volume demands it.
- **Single-run (`RunStore`) model tagging** out of scope — this is the scorecard/benchmark surface.

## See also

[scorecards.md](../scorecards.md) · [suites.md](../suites.md) (trend/diff) · [datasets.md](../datasets.md)
(benchmark→dataset import) · [scheduled-evals.md](./scheduled-evals.md) (same additive-generalization pattern) ·
rules `api-layer` / `db` / `mcp` / `core-contracts`.
