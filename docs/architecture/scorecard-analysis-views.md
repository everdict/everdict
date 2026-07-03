# Scorecard Analysis + Views (SSOT)

> One flexible analysis dashboard over scorecards (filter · group · aggregate · search) that **subsumes** the
> four scattered lenses (leaderboard / by-harness / trend / compare), plus a saved **`View`** entity that a
> member creates, keeps **live** (re-runs against current data, not a snapshot), and **shares** with the
> workspace. Design confirmed with the user (2026-07-03): single dashboard (no panels/versions), private + explicit
> share, doc-first.

## Problem

Scorecard analysis is fragmented across four routes, each with its own page, picker, and endpoint:

| Lens | Route | Data source | What it is |
| --- | --- | --- | --- |
| 리더보드 | `/scorecards/leaderboard` | `GET /scorecards/leaderboard?dataset` | rank harness×model by score, per benchmark |
| 하니스별 | `/scorecards/by-harness` | client group of `listScorecards` | each harness's score per benchmark |
| 추이 | `/scorecards/trend` | `GET /scorecards/trend?dataset&harness` | score over time |
| 비교 | `/scorecards/compare` | `GET /scorecards/diff?baseline&candidate` | regressions/improvements between two |

Each is a **fixed** slice. The user wants a **stock-analysis-style** dashboard: flexible filters, flexible
grouping, and search — one surface where any of those four (and combinations) are just *configurations* — and the
ability to **save** a configuration as a shareable `View`.

## Key insight: the four lenses are pivots over one dataset

`GET /scorecards` (`listScorecards`) already returns every record with the dimensions needed to pivot
(`ScorecardRecord`, per-case results omitted — light):

- **dimensions**: `dataset.{id,version}` · `harness.{id,version}` · `models.primary`/`observed` · `judgeModels` ·
  `status` · `origin.{source,repo,sha,ref}` · `createdBy` · `createdAt`
- **measures**: `summary[]` = per-metric `{metric, count, mean, passRate}` (the score) · row `count`

So the whole analysis is a **client-side pivot** over that array — no new heavy backend for the dashboard itself:

| Lens | = configuration of the pivot |
| --- | --- |
| 리더보드 | filter `dataset=X` · group by `[harness, model]` · measure `passRate` · sort desc |
| 하니스별 | group rows by `harness` · pivot columns by `dataset` · measure `passRate` |
| 추이 | filter `dataset=X, harness=Y` · group by `time bucket(createdAt)` · measure `passRate` → line |
| 비교 | pick two groups (e.g. two `harness.version`s, or two time buckets) · show **Δ** of `passRate` |

## The analysis model

A single **AnalysisConfig** drives the dashboard. It is also exactly what a `View` persists.

```ts
type Dimension =
  | 'dataset' | 'datasetVersion'
  | 'harness' | 'harnessVersion'
  | 'model' | 'judgeModel'
  | 'status' | 'originSource' | 'repo' | 'owner'
  | 'day' | 'week' | 'month'          // time buckets over createdAt

interface AnalysisConfig {
  filters: {                          // AND of these; each value list is OR
    dataset?: string[]; harness?: string[]; model?: string[]; status?: string[]
    originSource?: string[]; owner?: string[]; repo?: string[]
    from?: string; to?: string        // createdAt range (ISO)
    tags?: string[]
  }
  groupBy: Dimension[]                // 0..2 dims → grouped rows (e.g. [harness, model])
  pivotBy?: Dimension                 // optional column dimension (e.g. dataset) → matrix
  metric: string                      // which summary metric (default: the only/most-common one)
  measure: 'passRate' | 'mean' | 'count' | 'latest'
  compare?: { dim: Dimension; a: string; b: string }  // Δ between two values of a dim
  sort?: { by: 'measure' | 'label' | 'time'; dir: 'asc' | 'desc' }
  search?: string                     // free-text over dims (harness/model/dataset/owner…)
  viz: 'table' | 'bars' | 'line'      // line only meaningful when grouped by a time bucket
}
```

Rendering (S1, all client-side, extends the existing by-harness grouping code + shared atoms
`shared/lib/format`, `shared/ui/{score,chip}`):

- **table** — grouped rows (group label = the `groupBy` dims), measure cell(s); when `pivotBy` set, one column
  per pivot value (matrix); when `compare` set, an extra **Δ** column with a regression/improvement tone.
- **bars** — horizontal bars of the measure per group (leaderboard feel).
- **line** — measure over the time bucket (trend feel), reusing the existing SVG sparkline in `trend/page.tsx`.

The measure comes from `summary`: `passRate` (fallback `mean`) via the shared `fmtScore`/`rateHealth` atoms; a
group's value = mean of its rows' scores (or `latest` = most recent row's score). "Δ / 나빠짐" uses the same
regression semantics as `diffScorecards` but computed over the grouped values.

`superseded`/incomplete scorecards are excluded by default (a filter toggle can include them).

## The `View` entity

A `View` is a **named, saved `AnalysisConfig`** — the pivot recipe, not a data snapshot. Opening a View re-runs the
pivot against the **current** `listScorecards`, so new scorecards appear automatically (the "macro / 지속적" ask).

```ts
interface ViewRecord {
  id: string
  tenant: string                       // workspace = tenant = trust-zone
  name: string
  config: AnalysisConfig               // the saved recipe (validated by Zod at the boundary)
  visibility: 'private' | 'workspace'  // private (owner-only) | shared read-only to members
  createdBy: string                    // subject; owner
  createdAt: string
  updatedAt: string
}
```

**Ownership & sharing (confirmed: private + explicit share).**
- Created **private** — only the creator sees it (scoped `createdBy === principal.subject`).
- Owner flips `visibility: 'workspace'` → every member sees it **read-only** in a shared list.
- **Edit / delete / rename / change visibility** = **creator OR workspace admin** (mirror the schedule edit
  gate: enforced in `ViewService`, route/MCP inject `actor={subject,isAdmin}`; UI gates the buttons, control
  plane is authoritative). A non-owner opening a shared View can **fork** it (save a copy as their own private
  View) but not mutate the original.
- List response = my private Views + all `workspace`-visible Views; another workspace's View reads **404**.

## Architecture & slices

Follows the established entity pattern (like `schedules`): one service core, two transports (HTTP + MCP),
mem/Pg stores, Zod at every boundary, web is a pure HTTP mirror.

### S1 — Unified analysis dashboard (no backend change)
- New route `/{ws}/scorecards/analyze` — the flexible pivot over `listScorecards`, client-side. Filter bar +
  group-by/pivot pickers + measure/metric + sort + search + viz(table/bars/line). Reproduces all four lenses.
- `AnalysisConfig` lives in URL query (`?` params) so every configuration is deep-linkable/bookmarkable even
  before Views exist.
- Old routes (`leaderboard`/`by-harness`/`trend`/`compare`) → thin redirects to `/analyze?…preset`. The
  scorecards list page's analytics segment points at `/analyze`. Existing server endpoints
  (`leaderboard`/`trend`/`diff`) stay for MCP/agents; the web dashboard computes from `listScorecards`.
- Reuse: by-harness grouping logic, trend SVG sparkline, `shared/lib/format`, `shared/ui/{score,chip,stat-card}`.

### S2 — `View` entity (persist & load)
- `@assay/db`: `ViewStore` interface + `InMemoryViewStore` + `PgViewStore` + numbered migration
  (`assay_views`: id, tenant, name, config `jsonb`, visibility, created_by, created_at, updated_at; index on
  `(tenant, visibility)` and `(tenant, created_by)`).
- `apps/api`: `ViewService` (CRUD + ownership gate) + routes `POST/GET/GET :id/PATCH :id/DELETE :id /views` +
  `views:read`(viewer+) / `views:write`(member+) authz actions; MCP tools `create/list/get/update/delete_view`
  (BFF↔MCP parity). `config` validated by the same Zod `AnalysisConfigSchema` shared with the dashboard shape.
- `apps/web`: `entities/view` (Zod mirror) + save-current-config / load / list. Opening a View hydrates the
  dashboard from its `config`.

### S3 — Sharing + live
- Visibility toggle (`private ↔ workspace`) in the web + control-plane enforcement; shared Views list for members;
  **fork** action for non-owners. Deep-link `/{ws}/scorecards/analyze?view=<id>`.
- "Live" is inherent (re-run on open). Add a subtle "N개 스코어카드 기준 · 방금" freshness line so it's clear the
  View reflects current data.

### S4 — (optional / future)
- Server-side `POST /scorecards/analyze` (config → grouped result) for large workspaces where client-side pivot
  over all scorecards gets heavy; the web transparently switches when the record count crosses a threshold.
- "Macro" extensions if wanted later: pin a View to the overview, or subscribe (notify on regression in a View's
  metric — reuse the schedule regression-alert plumbing). **Not** in the initial scope (no panels/versions per the
  user).

## Non-goals (this iteration)
- No multi-panel dashboards, no View versioning (user: "패널이나 버전 있을 필요 없음").
- No new snapshotting — Views are recipes, always live.
- No per-case drill-down inside the dashboard (that stays on the scorecard detail page); the dashboard operates on
  the light `summary`, not per-case results.

## Open questions
- Default `metric` when a workspace mixes metric names across scorecards — pick the most frequent, expose a
  selector. (Most workspaces have one.)
- Time-bucket zero-filling for the `line` viz (gaps vs interpolate) — start with gaps.
