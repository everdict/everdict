---
kind: wiki
title: "Leaderboard — model as a first-class dimension (harness × model × benchmark)"
status: current
updated: 2026-09-15
anchors: [packages/domain/src/scorecard/leaderboard.ts, packages/domain/src/scorecard/models.ts]
---
# Leaderboard — model as a first-class dimension (harness × model × benchmark)

A public leaderboard (SWE-bench, GAIA, …) answers *for this benchmark, which harnesses and models score best?*
Everdict answers it self-serve over three axes: **benchmark** (dataset), **harness**, and **model**. The unit of
aggregation is the existing `ScorecardRecord` (dataset@v × harness@v, with a lightweight per-metric `summary`);
this page covers the `model` dimension on that record and the ranking view built on it.

## Model is per run, not per harness version

The same `command` harness version can be re-pinned to a different model, and a `process` harness (Claude Code)
may pin none at all — only its trace reveals what ran. So the leaderboard's model axis is **captured per
scorecard from the trace**, not derived from the harness spec. It is a run-derived string; it is not a reference
to the registered `Model` entity (`docs/models.md`) that harnesses and judges bind to.

## Capture: `models` on the scorecard record

`scorecardModels(sc, declared?)` (`packages/domain/src/scorecard/models.ts`) returns:

```ts
{ observed: string[];   // distinct llm_call.model across all case traces, sorted
  declared?: string;    // the spec-declared model (CommandHarnessSpec.model)
  primary?: string }    // group key: most-frequent observed (tie → lexicographically first), else declared
```

- **observed** is the ground truth of what ran; **declared** is configured intent, so the UI can flag
  declared ≠ observed drift; neither ⇒ `primary` unset ⇒ the row is grouped as **unknown**.
- Computed when a batch finalizes (`in-process-batch-driver.ts`, `workflow-batch-driver.ts`) and when an ingest
  finishes (`scorecard-ingest-service.ts`, observed only), all under `packages/application-control/src/scorecard/`.
- Stored in the `models jsonb` column on `everdict_scorecards` (migration `0028_add_scorecard_models.sql`),
  mirrored as `ScorecardModelsSchema` (`packages/contracts/src/records/scorecard.ts`) and included in the
  lightweight list, so every list/detail response carries it.
- **Backfill** for rows that predate capture: `POST /scorecards/backfill-models` (`scorecards:run`) and MCP
  `backfill_scorecard_models` recompute `models` from the stored traces of succeeded records lacking it
  (idempotent, observed only).

The judge's model is a separate axis — the scorer, not the harness under test — carried as `judgeModels`.

## Ranking: `leaderboard`

`leaderboard(cards, { datasetId, metric, harnessId?, model?, judgeModel?, window? })`
(`packages/domain/src/scorecard/leaderboard.ts`), called by `ScorecardAnalyticsService.leaderboard`
(`packages/application-control/src/scorecard/scorecard-analytics-service.ts`) over the lightweight list narrowed
in SQL to the dataset, `succeeded`, `kind: scorecard` (experiments never rank) and the optional harness:

- filters by `model` (against `models.primary`) and `judgeModel` (a fair comparison among runs scored by the
  same judge model);
- groups by `harness.id@version × models.primary` and collapses each group to one representative scorecard —
  `window=latest` (default, newest) or `best` (highest score, newest on a tie) — with `runs` = group size;
- `score = summary[metric].passRate ?? mean`; a metric with no measured value contributes no score and ranks last;
- ranks in the metric's declared direction (a `lower_is_better` metric such as cost ranks ascending);
- a row with no model is marked `modelUnknown`; a board whose batches were judged under different verdict
  policies is marked `policyMixed`.

`metric` is an explicit axis; when absent the service picks the highest-authority pass-rate metric present in the
data (`preferredMetric`) rather than a literal default.

## Surface (BFF↔MCP parity)

- **HTTP** — `GET /scorecards/leaderboard?dataset=&metric=&harness=&model=&judgeModel=&window=` (`dataset`
  required; `scorecards:read`).
- **MCP** — `leaderboard_scorecards`, same core. The trend lens has its MCP twin too (`trend_scorecards`).
- **Web** — `/{ws}/scorecards/leaderboard` (`LeaderboardPicker`, `apps/web/src/features/leaderboard-scorecards`):
  dataset + metric + window → ranked table with a model chip and an unknown-model label. The model also appears
  on the scorecard list rows, on the detail page (primary + observed chips + a declared ≠ actual drift badge),
  and per side on the compare page. `/{ws}/scorecards/by-harness` is the harness-centric history (one harness's
  scorecards grouped by dataset).

The same dimensions are also available in the general pivot (`model`, `judgeModel` in
[scorecard-analysis-views.md](./scorecard-analysis-views.md)).

## Decisions / non-goals

- **Observed-first, declared fallback, store both.** Rank by what actually ran while surfacing config drift.
- **Metric is an explicit ranking axis** — no assumed universal headline metric.
- **No store-level model filter** — model and judge-model narrowing happens in the domain over the lightweight
  list; SQL narrows only dataset, status, kind and harness.
- **Single-run (`RunStore`) model tagging** is out of scope — this is the scorecard/benchmark surface.

## See also

[scorecards.md](../scorecards.md) · [suites.md](../suites.md) (trend/diff) · [datasets.md](../datasets.md)
(benchmark→dataset import).
