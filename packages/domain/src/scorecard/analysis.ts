import type { MetricSummary } from "./scorecard.js";

// Flexible scorecard analysis — a pure pivot (filter/group/pivot/measure/sort/search) over the *lightweight*
// scorecard list shape. This is the server-side twin of the web pivot engine
// (apps/web/src/features/analyze-scorecards/model/analysis.ts) — the two implementations MUST stay in lockstep
// (the web one is client-side for interactive dashboards; this one powers POST /scorecards/query + the agent).
// Leaderboard/by-harness/trend/compare are all reproduced as configurations of this one model.
// Design: docs/architecture/scorecard-analysis-views.md + docs/architecture/analysis-studio.md (V1).

export type AnalysisDimension =
  | "dataset"
  | "datasetVersion"
  | "harness"
  | "harnessVersion"
  | "model"
  | "judgeModel"
  | "status"
  | "originSource"
  | "repo"
  | "owner"
  | "day"
  | "week"
  | "month";

export const ANALYSIS_DIMENSIONS: readonly AnalysisDimension[] = [
  "dataset",
  "datasetVersion",
  "harness",
  "harnessVersion",
  "model",
  "judgeModel",
  "status",
  "originSource",
  "repo",
  "owner",
  "day",
  "week",
  "month",
];

export const ANALYSIS_TIME_DIMENSIONS: readonly AnalysisDimension[] = ["day", "week", "month"];

export type AnalysisMeasure = "passRate" | "mean" | "count" | "latest";
export const ANALYSIS_MEASURES: readonly AnalysisMeasure[] = ["passRate", "mean", "count", "latest"];

export type AnalysisViz = "table" | "bars" | "line";
export const ANALYSIS_VIZ: readonly AnalysisViz[] = ["table", "bars", "line"];

export interface AnalysisFilters {
  dataset?: string[];
  harness?: string[];
  model?: string[];
  judgeModel?: string[]; // the judge's own model (a groupable dim; also filterable so a View can pin one judge model)
  status?: string[];
  owner?: string[];
  originSource?: string[];
  from?: string; // createdAt >= (ISO date)
  to?: string; // createdAt <= (ISO date, inclusive of day)
}

export interface AnalysisConfig {
  filters: AnalysisFilters;
  groupBy: AnalysisDimension[]; // 0..2 dims → group rows
  pivotBy?: AnalysisDimension; // optional column dimension → matrix
  metric?: string; // which summary metric (unset = each card's first summary row)
  measure: AnalysisMeasure;
  sort: { by: "measure" | "label"; dir: "asc" | "desc" };
  search?: string;
  viz: AnalysisViz;
  includeIncomplete?: boolean; // include superseded/cancelled/queued/running (excluded by default)
}

// The lightweight shape the pivot reads — the scorecard list record satisfies this structurally
// (summary/models/origin/createdBy are all list-included fields; no heavy per-case results needed).
export interface AnalysisCard {
  id: string;
  dataset: { id: string; version: string };
  harness: { id: string; version: string };
  status: string;
  createdAt: string; // ISO
  summary?: MetricSummary[];
  models?: { observed?: string[]; primary?: string };
  judgeModels?: string[];
  origin?: { source?: string; repo?: string };
  createdBy?: string;
}

export interface AnalysisGridRow {
  key: string;
  labels: string[]; // raw label per groupBy dimension (owner = the subject; display resolution is the caller's)
  count: number; // scorecards in the group
  cases: number; // scored cases behind the value — the sample size, NOT the scorecard count
  value?: number; // measured value over the whole group (also the sort key when sorting by measure)
  cells: { key: string; value?: number }[]; // value per pivot column ([] when no pivotBy)
}
export interface AnalysisGridResult {
  kind: "grid";
  rows: AnalysisGridRow[];
  pivotKeys: string[]; // pivotBy values (sorted); [] if none
  metric?: string;
  total: number; // number of scorecards that passed the filters
}
export interface AnalysisLineResult {
  kind: "line";
  buckets: string[]; // time buckets (sorted)
  series: { label: string; points: (number | undefined)[] }[];
  metric?: string;
  total: number;
}
export type AnalysisResult = AnalysisGridResult | AnalysisLineResult;

const UNKNOWN = "—";

// Group-key separator — an unprintable unit separator so multi-dimension keys cannot collide
// ("a·bc" vs "ab·c"). The web engine uses the same separator.
const KEY_SEPARATOR = "\u0001";

function isoWeek(iso: string): string {
  const d = new Date(iso);
  // ISO week approximation — YYYY-Www (for display). Thursday-based.
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(((d.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// A scorecard's raw dimension value (owner = the subject — display names are resolved by the caller at render).
export function analysisDimensionValue(card: AnalysisCard, dim: AnalysisDimension): string {
  switch (dim) {
    case "dataset":
      return card.dataset.id;
    case "datasetVersion":
      return `${card.dataset.id}@${card.dataset.version}`;
    case "harness":
      return card.harness.id;
    case "harnessVersion":
      return `${card.harness.id}@${card.harness.version}`;
    case "model":
      return card.models?.primary ?? card.models?.observed?.[0] ?? UNKNOWN;
    case "judgeModel":
      return card.judgeModels?.[0] ?? UNKNOWN;
    case "status":
      return card.status;
    case "originSource":
      return card.origin?.source ?? UNKNOWN;
    case "repo":
      return card.origin?.repo ?? UNKNOWN;
    case "owner":
      return card.createdBy ?? UNKNOWN;
    case "day":
      return card.createdAt.slice(0, 10);
    case "week":
      return isoWeek(card.createdAt);
    case "month":
      return card.createdAt.slice(0, 7);
  }
}

// The summary row this card contributes for the selected metric. An explicitly selected but absent metric
// falls back to the card's first summary row (recipe semantics — a View saved against a metric another
// harness doesn't emit still renders something comparable).
function summaryOf(card: AnalysisCard, metric: string | undefined): MetricSummary | undefined {
  const rows = card.summary ?? [];
  return (metric ? rows.find((r) => r.metric === metric) : undefined) ?? rows[0];
}

// This card's score for the selected metric — passRate first, else mean.
function scoreOf(card: AnalysisCard, metric: string | undefined): number | undefined {
  const row = summaryOf(card, metric);
  if (!row) return undefined;
  return row.passRate ?? row.mean;
}

// How many scored cases stand behind this card's score — the weight it earns in a group aggregate.
// A row that reports no usable count still counts once rather than vanishing: an unknown weight is a
// reason to under-trust the number, not to drop the record.
function weightOf(row: MetricSummary): number {
  return Number.isFinite(row.count) && row.count > 0 ? row.count : 1;
}

// A group's (bundle of cards) measured value.
function aggregate(cards: AnalysisCard[], metric: string | undefined, measure: AnalysisMeasure): number | undefined {
  if (cards.length === 0) return undefined;
  if (measure === "count") return cards.length;
  if (measure === "latest") {
    const latest = [...cards].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return latest ? scoreOf(latest, metric) : undefined;
  }
  // passRate | mean — weighted by each card's CASE COUNT, never a plain mean of per-card rates. A rate is a
  // ratio, so a bundle's rate is Σ(rate·n)/Σn: averaging the rates instead would let a 5-case smoke run
  // outweigh a 500-case suite and make a leaderboard rank turn on how many small runs someone launched.
  let weighted = 0;
  let cases = 0;
  for (const card of cards) {
    const row = summaryOf(card, metric);
    if (!row) continue;
    const value = row.passRate ?? row.mean;
    if (value === undefined) continue;
    const w = weightOf(row);
    weighted += value * w;
    cases += w;
  }
  return cases === 0 ? undefined : weighted / cases;
}

// The scored cases behind a group — the sample size the group's rate was computed over. Reported next to the
// value so a reader can tell "0.9 over 500 cases" from "0.9 over 5".
function caseCount(cards: AnalysisCard[], metric: string | undefined): number {
  let cases = 0;
  for (const card of cards) {
    const row = summaryOf(card, metric);
    if (row) cases += weightOf(row);
  }
  return cases;
}

// All metric names across the cards, most frequent first — the vocabulary a caller (web picker / agent) selects from.
export function analysisMetricNames(cards: AnalysisCard[]): string[] {
  const freq = new Map<string, number>();
  for (const card of cards) for (const s of card.summary ?? []) freq.set(s.metric, (freq.get(s.metric) ?? 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m);
}

function passesFilters(card: AnalysisCard, c: AnalysisConfig, resolveOwner: (subject: string) => string): boolean {
  const f = c.filters;
  if (
    !c.includeIncomplete &&
    (card.status === "superseded" ||
      card.status === "cancelled" ||
      card.status === "queued" ||
      card.status === "running")
  )
    return false;
  const inList = (list: string[] | undefined, v: string) => !list || list.length === 0 || list.includes(v);
  if (!inList(f.dataset, card.dataset.id)) return false;
  if (!inList(f.harness, card.harness.id)) return false;
  if (!inList(f.model, analysisDimensionValue(card, "model"))) return false;
  if (!inList(f.judgeModel, analysisDimensionValue(card, "judgeModel"))) return false;
  if (!inList(f.status, card.status)) return false;
  if (!inList(f.owner, card.createdBy ?? UNKNOWN)) return false;
  if (!inList(f.originSource, analysisDimensionValue(card, "originSource"))) return false;
  if (f.from && card.createdAt.slice(0, 10) < f.from) return false;
  if (f.to && card.createdAt.slice(0, 10) > f.to) return false;
  if (c.search) {
    const q = c.search.trim().toLowerCase();
    if (q) {
      const hay = [
        card.dataset.id,
        card.harness.id,
        analysisDimensionValue(card, "model"),
        analysisDimensionValue(card, "originSource"),
        card.origin?.repo ?? "",
        resolveOwner(card.createdBy ?? ""),
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
  }
  return true;
}

function groupKey(card: AnalysisCard, dims: AnalysisDimension[]): string {
  return dims.map((d) => analysisDimensionValue(card, d)).join(KEY_SEPARATOR);
}

// Main — cards + config → result (grid|line). resolveOwner maps a subject to a display name (labels + search
// haystack); the server passes identity and lets the web resolve at render. allLabel names the single series
// when a line chart has no series dimension (the web injects its locale label).
export function computeAnalysis(
  cards: AnalysisCard[],
  config: AnalysisConfig,
  opts: { resolveOwner?: (subject: string) => string; allLabel?: string } = {},
): AnalysisResult {
  const resolveOwner = opts.resolveOwner ?? ((s: string) => s);
  const allLabel = opts.allLabel ?? "all";
  const filtered = cards.filter((card) => passesFilters(card, config, resolveOwner));
  const metric = config.metric;
  const labelOf = (dim: AnalysisDimension, raw: string) => (dim === "owner" ? resolveOwner(raw) : raw);

  if (config.viz === "line") {
    // x-axis = the time dimension in groupBy (the first one), series = the remaining groupBy dimension (if any).
    const timeDim = config.groupBy.find((d) => ANALYSIS_TIME_DIMENSIONS.includes(d)) ?? "day";
    const seriesDim = config.groupBy.find((d) => !ANALYSIS_TIME_DIMENSIONS.includes(d));
    const buckets = [...new Set(filtered.map((card) => analysisDimensionValue(card, timeDim)))].sort();
    const seriesKeys = seriesDim
      ? [...new Set(filtered.map((card) => analysisDimensionValue(card, seriesDim)))].sort()
      : [allLabel];
    const series = seriesKeys.map((sk) => ({
      label: seriesDim ? labelOf(seriesDim, sk) : allLabel,
      points: buckets.map((b) =>
        aggregate(
          filtered.filter(
            (card) =>
              analysisDimensionValue(card, timeDim) === b &&
              (!seriesDim || analysisDimensionValue(card, seriesDim) === sk),
          ),
          metric,
          config.measure,
        ),
      ),
    }));
    return { kind: "line", buckets, series, ...(metric !== undefined ? { metric } : {}), total: filtered.length };
  }

  // grid (table | bars)
  const groups = new Map<string, AnalysisCard[]>();
  for (const card of filtered) {
    const k = groupKey(card, config.groupBy);
    groups.set(k, [...(groups.get(k) ?? []), card]);
  }
  const pivotBy = config.pivotBy;
  const pivotKeys = pivotBy ? [...new Set(filtered.map((card) => analysisDimensionValue(card, pivotBy)))].sort() : [];

  let rows: AnalysisGridRow[] = [...groups.entries()].map(([key, groupCards]) => {
    const first = groupCards[0];
    const labels = config.groupBy.map((d) => labelOf(d, first ? analysisDimensionValue(first, d) : ""));
    const cells = pivotBy
      ? pivotKeys.map((pk) => ({
          key: pk,
          value: aggregate(
            groupCards.filter((c) => analysisDimensionValue(c, pivotBy) === pk),
            metric,
            config.measure,
          ),
        }))
      : [];
    return {
      key,
      labels,
      count: groupCards.length,
      cases: caseCount(groupCards, metric),
      value: aggregate(groupCards, metric, config.measure),
      cells,
    };
  });

  const dir = config.sort.dir === "asc" ? 1 : -1;
  rows = rows.sort((a, b) => {
    if (config.sort.by === "label") return dir * a.labels.join(" ").localeCompare(b.labels.join(" "));
    const av = a.value ?? Number.NEGATIVE_INFINITY;
    const bv = b.value ?? Number.NEGATIVE_INFINITY;
    return dir * (av - bv);
  });

  return { kind: "grid", rows, pivotKeys, ...(metric !== undefined ? { metric } : {}), total: filtered.length };
}
