---
kind: wiki
title: "Scorecard Analysis + Views (SSOT)"
status: current
updated: 2026-09-15
anchors: [packages/domain/src/scorecard/analysis.ts, apps/web/src/features/analyze-scorecards/model/analysis.ts, packages/application-control/src/view/view-service.ts, packages/contracts/src/records/view.ts]
---
# Scorecard Analysis + Views (SSOT)

One flexible pivot over scorecards (filter · group · pivot · measure · sort · search), and a saved **`View`**
entity: a named pivot recipe a member keeps **live** (it re-runs against current data, never a snapshot) and can
**share** with the workspace. The conversational surface that drives it — the studio canvas, the agent's
`apply_view_config`, artifacts and scheduled reports — is [analysis-studio.md](./analysis-studio.md).

## The four lenses are pivots over one dataset

The scorecard list record carries every dimension a pivot needs without per-case results:

- **dimensions**: `dataset.{id,version}` · `harness.{id,version}` · `models.primary`/`observed` · `judgeModels` ·
  `status` · `origin.{source,repo}` · `createdBy` · `createdAt`
- **measures**: `summary[]` = per-metric `{metric, count, mean, passRate}` · the row count

So a leaderboard (filter one dataset, group by `[harness, model]`, `passRate`, sort desc), a by-harness matrix
(group by `harness`, pivot by `dataset`) and a trend (group by a time bucket, `line`) are configurations of one
engine. The dedicated `/scorecards/leaderboard`, `/scorecards/by-harness`, `/scorecards/trend` and
`/scorecards/compare` web pages, and the `GET /scorecards/leaderboard` · `/trend` · `/diff` endpoints, remain as
separate surfaces.

## The analysis model

`AnalysisConfig` (`packages/domain/src/scorecard/analysis.ts`) drives the pivot and is exactly what a `View`
persists:

```ts
type AnalysisDimension =
  | "dataset" | "datasetVersion" | "harness" | "harnessVersion" | "model" | "judgeModel"
  | "status" | "originSource" | "repo" | "owner" | "day" | "week" | "month";   // time buckets over createdAt

interface AnalysisConfig {
  filters: { dataset?, harness?, model?, judgeModel?, status?, owner?, originSource?: string[]; from?, to?: string };
  groupBy: AnalysisDimension[];   // 0..2 dims → grouped rows
  pivotBy?: AnalysisDimension;    // optional column dimension → matrix
  metric?: string;                // which summary metric
  measure: "passRate" | "mean" | "count" | "latest";
  sort: { by: "measure" | "label"; dir: "asc" | "desc" };
  search?: string;
  viz: "table" | "bars" | "line";
  includeIncomplete?: boolean;    // superseded / cancelled / queued / running are excluded by default
}
```

- **Two engines in lockstep.** `computeAnalysis` runs client-side in the web
  (`apps/web/src/features/analyze-scorecards/model/analysis.ts`) and server-side in the domain, where it powers
  `POST /scorecards/query` and MCP `query_scorecards` (`apps/api/src/api/scorecard/request/analysis-query.ts`).
  A parity test (`apps/web/src/features/analyze-scorecards/model/analysis-parity.test.ts`) holds them together,
  and a compile-time guard keeps the API's dimension list equal to the domain union.
- **Case-weighted aggregation.** A group's `passRate`/`mean` is Σ(rate·n)/Σn over its scorecards, not the mean of
  per-scorecard rates, so a 5-case smoke run does not weigh the same as a 500-case suite. Rows carry `cases` (the
  sample size) separately from `count` (the scorecards); a summary row with no usable count weighs 1. A
  scorecard lacking the selected metric is reported as `missing`, never substituted with another metric.
- **Rendering** — `table` (grouped rows; one column per pivot value when `pivotBy` is set), `bars`, and `line`
  (over the time bucket), all through `shared/ui/charts` (see skill `web`). Ratio measures pin the axis to 0–100%.
- **Raw rows as a drill-down.** Clicking a mark scopes a table of the underlying scorecards to that group
  (`filterScorecards`/`groupKeyOf`/`timeDimensionOf` apply the identical predicate, so the rows cannot disagree
  with the number). It pages 50 rows at a time with an explicit "showing N of M". Re-shaping the analysis clears
  the focus.

## The `View` entity

A `View` (`packages/contracts/src/records/view.ts`) is a named, saved `AnalysisConfig` — the recipe, not the
data. Opening a View re-runs the pivot against current scorecards.

```ts
interface ViewRecord {
  id: string; tenant: string; name: string;
  config: unknown;                      // opaque jsonb to the control plane; the web owns its shape
  visibility: "private" | "workspace";  // owner-only | shared read-only to members
  createdBy: string; createdAt: string; updatedAt: string;
}
```

- **Storage** — `ViewStore` with in-memory and Postgres implementations (`packages/db/src/results/view-store.ts`),
  migration `0038_create_views.sql` (`everdict_views`, one index on `(tenant, visibility, created_at DESC)`).
  `listVisible(tenant, subject)` = `visibility='workspace' OR created_by=subject`.
- **Service** — `ViewService` (`packages/application-control/src/view/view-service.ts`): created private by
  default; edit, delete, rename and visibility changes are allowed to the creator or a workspace admin. Another
  workspace's View, or another member's private one, reads **404**, not 403.
- **Transports** (`apps/api/src/api/view/view.routes.ts` · `view.mcp.ts`): `POST/GET /views`,
  `GET/PATCH/DELETE /views/:id`, and MCP `create_view` · `list_views` · `get_view` · `update_view` ·
  `delete_view`. Reads gate on `scorecards:read`, writes on `scorecards:run` — a View is a lens over scorecards,
  so it inherits their permissions rather than adding a `views:*` axis.
- **Config round trip** — the web stores the flat params form (`configToStored`) and loads it through
  `storedToConfig` → `paramsToConfig`, which re-validates and normalizes every field, so a stored recipe can
  never open as an invalid config.
- **Captures** — `POST /views/:id/snapshots` (MCP `capture_view_snapshot`, `ViewSnapshotService`) computes the
  View server-side and writes `views/<id>/<capturedAt>.json` onto the workspace filesystem: the numbers, the
  config that produced them and the sample size. A report-mode schedule captures before its agent turn. There is
  no snapshot list endpoint; reads go through `/fs` (`docs/architecture/workspace-filesystem.md`).

## Web

- `/{ws}/scorecards/analyze` — the studio canvas (`CustomAnalyzer`), described in
  [analysis-studio.md](./analysis-studio.md). A `?view=<id>` deep link or config params fill it on arrival;
  `SaveAnalysisButton` saves the current lens as a View or updates the open one.
- `/{ws}/views` — the sidebar's Views entry (`apps/web/src/widgets/app-shell/ui/nav-config.ts`). `ViewList` cards
  show the name, a visibility badge, `describeConfig` chips and the owner; the owner or an admin can toggle
  sharing or delete.
- `/{ws}/views/[id]` — opens a View in `CustomAnalyzer`, live; a missing or foreign-private View is `notFound()`.
- `loadAnalysisData()` (`apps/web/src/features/analyze-scorecards/api/load-analysis-data.ts`) is the shared
  server loader for the analyze canvas and both Views pages.

## Not built

- **Fork** — a non-owner cannot copy a shared View into a private one; they can load it and change the URL state,
  but not persist over someone else's View.
- Multi-panel dashboards and View versioning.
- Per-case drill-down inside the pivot — it operates on the light `summary`; per-case results stay on the
  scorecard detail page.
