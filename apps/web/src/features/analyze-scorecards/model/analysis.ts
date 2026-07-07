import type { ScorecardRecord } from '@/entities/scorecard'

// Flexible scorecard analysis engine — a pure pivot over the listScorecards array (filter/group/measure/sort/search).
// Leaderboard/by-harness/trend/compare are all reproduced as compositions of this config. Design: docs/architecture/scorecard-analysis-views.md.

// Minimal translator signature for label resolution — structurally compatible with next-intl's useTranslations/getTranslations return.
// The model stays framework-agnostic; the caller (bound to the analyzeScorecards namespace) injects t.
type Translate = (key: string, values?: Record<string, string | number>) => string

export type Dimension =
  | 'dataset'
  | 'datasetVersion'
  | 'harness'
  | 'harnessVersion'
  | 'model'
  | 'judgeModel'
  | 'status'
  | 'originSource'
  | 'repo'
  | 'owner'
  | 'day'
  | 'week'
  | 'month'

export const TIME_DIMENSIONS: Dimension[] = ['day', 'week', 'month']

// Dimension → catalog key (analyzeScorecards namespace). Display strings are resolved at render via t().
export const DIMENSION_KEY: Record<Dimension, string> = {
  dataset: 'dimDataset',
  datasetVersion: 'dimDatasetVersion',
  harness: 'dimHarness',
  harnessVersion: 'dimHarnessVersion',
  model: 'dimModel',
  judgeModel: 'dimJudgeModel',
  status: 'dimStatus',
  originSource: 'dimOriginSource',
  repo: 'dimRepo',
  owner: 'dimOwner',
  day: 'dimDay',
  week: 'dimWeek',
  month: 'dimMonth',
}

export type Measure = 'passRate' | 'mean' | 'count' | 'latest'
export const MEASURE_KEY: Record<Measure, string> = {
  passRate: 'measurePassRate',
  mean: 'measureMean',
  count: 'measureCount',
  latest: 'measureLatest',
}

export type Viz = 'table' | 'bars' | 'line'

export interface AnalysisFilters {
  dataset?: string[]
  harness?: string[]
  model?: string[]
  status?: string[]
  owner?: string[]
  originSource?: string[]
  from?: string // createdAt >= (ISO date)
  to?: string // createdAt <= (ISO date, inclusive of day)
}

export interface AnalysisConfig {
  filters: AnalysisFilters
  groupBy: Dimension[] // 0..2 dims → group rows
  pivotBy?: Dimension // optional column dimension → matrix
  metric?: string // which summary metric (unset = the most common one)
  measure: Measure
  sort: { by: 'measure' | 'label'; dir: 'asc' | 'desc' }
  search?: string
  viz: Viz
  includeIncomplete?: boolean // include superseded/incomplete (excluded by default)
}

export const DEFAULT_CONFIG: AnalysisConfig = {
  filters: {},
  groupBy: ['harness'],
  measure: 'passRate',
  sort: { by: 'measure', dir: 'desc' },
  viz: 'table',
}

const UNKNOWN = '—'

function isoWeek(iso: string): string {
  const d = new Date(iso)
  // ISO week approximation — YYYY-Www (for display). Thursday-based.
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day + 3)
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  const week =
    1 +
    Math.round(
      ((d.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7
    )
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

// A scorecard's dimension value (raw — owner is the subject; the display name is resolved at render).
export function dimValue(sc: ScorecardRecord, dim: Dimension): string {
  switch (dim) {
    case 'dataset':
      return sc.dataset.id
    case 'datasetVersion':
      return `${sc.dataset.id}@${sc.dataset.version}`
    case 'harness':
      return sc.harness.id
    case 'harnessVersion':
      return `${sc.harness.id}@${sc.harness.version}`
    case 'model':
      return sc.models?.primary ?? sc.models?.observed?.[0] ?? UNKNOWN
    case 'judgeModel':
      return sc.judgeModels?.[0] ?? UNKNOWN
    case 'status':
      return sc.status
    case 'originSource':
      return sc.origin?.source ?? UNKNOWN
    case 'repo':
      return sc.origin?.repo ?? UNKNOWN
    case 'owner':
      return sc.createdBy ?? UNKNOWN
    case 'day':
      return sc.createdAt.slice(0, 10)
    case 'week':
      return isoWeek(sc.createdAt)
    case 'month':
      return sc.createdAt.slice(0, 7)
  }
}

// This scorecard's score (for the selected metric) — passRate first, else mean.
function scoreOf(sc: ScorecardRecord, metric: string | undefined): number | undefined {
  const rows = sc.summary ?? []
  const row = (metric ? rows.find((r) => r.metric === metric) : undefined) ?? rows[0]
  if (!row) return undefined
  return row.passRate ?? row.mean
}

// A group's (bundle of scorecards) measured value.
function aggregate(
  cards: ScorecardRecord[],
  metric: string | undefined,
  measure: Measure
): number | undefined {
  if (cards.length === 0) return undefined
  if (measure === 'count') return cards.length
  if (measure === 'latest') {
    const latest = [...cards].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    return latest ? scoreOf(latest, metric) : undefined
  }
  // passRate | mean — the average of each card's score (only the defined ones)
  const vals = cards.map((c) => scoreOf(c, metric)).filter((v): v is number => v !== undefined)
  if (vals.length === 0) return undefined
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

// All metric names in the workspace (by frequency) + the default metric.
export function metricsOf(scorecards: ScorecardRecord[]): string[] {
  const freq = new Map<string, number>()
  for (const sc of scorecards)
    for (const s of sc.summary ?? []) freq.set(s.metric, (freq.get(s.metric) ?? 0) + 1)
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m)
}

// Passes the filters?
function passesFilters(
  sc: ScorecardRecord,
  c: AnalysisConfig,
  resolveOwner: (s: string) => string
): boolean {
  const f = c.filters
  if (
    !c.includeIncomplete &&
    (sc.status === 'superseded' || sc.status === 'queued' || sc.status === 'running')
  )
    return false
  const inList = (list: string[] | undefined, v: string) =>
    !list || list.length === 0 || list.includes(v)
  if (!inList(f.dataset, sc.dataset.id)) return false
  if (!inList(f.harness, sc.harness.id)) return false
  if (!inList(f.model, dimValue(sc, 'model'))) return false
  if (!inList(f.status, sc.status)) return false
  if (!inList(f.owner, sc.createdBy ?? UNKNOWN)) return false
  if (!inList(f.originSource, dimValue(sc, 'originSource'))) return false
  if (f.from && sc.createdAt.slice(0, 10) < f.from) return false
  if (f.to && sc.createdAt.slice(0, 10) > f.to) return false
  if (c.search) {
    const q = c.search.trim().toLowerCase()
    if (q) {
      const hay = [
        sc.dataset.id,
        sc.harness.id,
        dimValue(sc, 'model'),
        dimValue(sc, 'originSource'),
        sc.origin?.repo ?? '',
        resolveOwner(sc.createdBy ?? ''),
      ]
        .join(' ')
        .toLowerCase()
      if (!hay.includes(q)) return false
    }
  }
  return true
}

export interface GridRow {
  key: string
  labels: string[] // label per groupBy dimension (for display; owner is resolved)
  count: number
  value?: number // measured value when there is no pivot
  cells: { key: string; value?: number }[] // value per pivot column
}
export interface GridResult {
  kind: 'grid'
  rows: GridRow[]
  pivotKeys: string[] // pivotBy values (sorted); [] if none
  metric?: string
  total: number // number of scorecards that passed the filters
}
export interface LineResult {
  kind: 'line'
  buckets: string[] // time buckets (sorted)
  series: { label: string; points: (number | undefined)[] }[]
  metric?: string
  total: number
}
export type AnalysisResult = GridResult | LineResult

function groupKey(sc: ScorecardRecord, dims: Dimension[]): string {
  return dims.map((d) => dimValue(sc, d)).join('')
}

// Main — scorecard array + config → result (grid|line). resolveOwner: subject→display name.
export function computeAnalysis(
  scorecards: ScorecardRecord[],
  config: AnalysisConfig,
  resolveOwner: (s: string) => string = (s) => s,
  allLabel: string = '전체' // single-series label when there is no series dimension (the caller injects t('all'))
): AnalysisResult {
  const filtered = scorecards.filter((sc) => passesFilters(sc, config, resolveOwner))
  const metric = config.metric
  const labelOf = (dim: Dimension, raw: string) => (dim === 'owner' ? resolveOwner(raw) : raw)

  if (config.viz === 'line') {
    // x-axis = the time dimension in groupBy (the first one), series = the remaining groupBy dimension (if any).
    const timeDim = config.groupBy.find((d) => TIME_DIMENSIONS.includes(d)) ?? 'day'
    const seriesDim = config.groupBy.find((d) => !TIME_DIMENSIONS.includes(d))
    const buckets = [...new Set(filtered.map((sc) => dimValue(sc, timeDim)))].sort()
    const seriesKeys = seriesDim
      ? [...new Set(filtered.map((sc) => dimValue(sc, seriesDim)))].sort()
      : [allLabel]
    const series = seriesKeys.map((sk) => ({
      label: seriesDim ? labelOf(seriesDim, sk) : allLabel,
      points: buckets.map((b) =>
        aggregate(
          filtered.filter(
            (sc) => dimValue(sc, timeDim) === b && (!seriesDim || dimValue(sc, seriesDim) === sk)
          ),
          metric,
          config.measure
        )
      ),
    }))
    return { kind: 'line', buckets, series, metric, total: filtered.length }
  }

  // grid (table | bars)
  const groups = new Map<string, ScorecardRecord[]>()
  for (const sc of filtered) {
    const k = groupKey(sc, config.groupBy)
    groups.set(k, [...(groups.get(k) ?? []), sc])
  }
  const pivotKeys = config.pivotBy
    ? [...new Set(filtered.map((sc) => dimValue(sc, config.pivotBy as Dimension)))].sort()
    : []

  let rows: GridRow[] = [...groups.entries()].map(([key, cards]) => {
    const first = cards[0]
    const labels = config.groupBy.map((d) => labelOf(d, first ? dimValue(first, d) : ''))
    const cells = config.pivotBy
      ? pivotKeys.map((pk) => ({
          key: pk,
          value: aggregate(
            cards.filter((c) => dimValue(c, config.pivotBy as Dimension) === pk),
            metric,
            config.measure
          ),
        }))
      : []
    return {
      key,
      labels,
      count: cards.length,
      value: aggregate(cards, metric, config.measure),
      cells,
    }
  })

  const dir = config.sort.dir === 'asc' ? 1 : -1
  rows = rows.sort((a, b) => {
    if (config.sort.by === 'label')
      return dir * a.labels.join(' ').localeCompare(b.labels.join(' '))
    const av = a.value ?? -Infinity
    const bv = b.value ?? -Infinity
    return dir * (av - bv)
  })

  return { kind: 'grid', rows, pivotKeys, metric, total: filtered.length }
}

const VIZ_KEY: Record<Viz, string> = { table: 'vizTable', bars: 'vizBars', line: 'trend' }

// Render the config as a short list of human-readable chips — so a View card describes itself (group/column/measure/shape/filter count).
// t = the analyzeScorecards namespace translator (caller-injected; getTranslations on the server, useTranslations on the client).
export function describeConfig(c: AnalysisConfig, t: Translate): string[] {
  const chips: string[] = []
  if (c.groupBy.length)
    chips.push(t('descGroup', { dims: c.groupBy.map((d) => t(DIMENSION_KEY[d])).join('·') }))
  if (c.pivotBy) chips.push(t('descPivot', { dim: t(DIMENSION_KEY[c.pivotBy]) }))
  chips.push(t(MEASURE_KEY[c.measure]))
  chips.push(t(VIZ_KEY[c.viz]))
  const activeFilters = Object.values(c.filters).filter((v) =>
    Array.isArray(v) ? v.length > 0 : Boolean(v)
  ).length
  if (activeFilters > 0) chips.push(t('descFilters', { count: activeFilters }))
  return chips
}

// ── URL codec (config ↔ query) — for deep-linking/sharing. ────────────────────────────────
export function configToParams(c: AnalysisConfig): URLSearchParams {
  const p = new URLSearchParams()
  const f = c.filters
  const csv = (k: string, v?: string[]) => v && v.length > 0 && p.set(k, v.join(','))
  csv('dataset', f.dataset)
  csv('harness', f.harness)
  csv('model', f.model)
  csv('status', f.status)
  csv('owner', f.owner)
  csv('origin', f.originSource)
  if (f.from) p.set('from', f.from)
  if (f.to) p.set('to', f.to)
  if (c.groupBy.length) p.set('group', c.groupBy.join(','))
  if (c.pivotBy) p.set('pivot', c.pivotBy)
  if (c.metric) p.set('metric', c.metric)
  p.set('measure', c.measure)
  p.set('sort', `${c.sort.by}:${c.sort.dir}`)
  if (c.search) p.set('q', c.search)
  p.set('viz', c.viz)
  if (c.includeIncomplete) p.set('incomplete', '1')
  return p
}

// ── View persistence codec — store config as a flat string map (jsonb-safe), and restore by validating through paramsToConfig. ──
// The saved form is a "recipe", not a snapshot, so on open paramsToConfig normalizes every field (a safe config even if malformed).
export function configToStored(c: AnalysisConfig): Record<string, string> {
  return Object.fromEntries(configToParams(c))
}
export function storedToConfig(raw: unknown): AnalysisConfig {
  const rec: Record<string, string | undefined> = {}
  if (raw && typeof raw === 'object')
    for (const [k, v] of Object.entries(raw as Record<string, unknown>))
      if (typeof v === 'string') rec[k] = v
  return paramsToConfig(rec)
}

const DIMS = new Set<string>(Object.keys(DIMENSION_KEY))
const isDim = (v: string): v is Dimension => DIMS.has(v)

export function paramsToConfig(params: Record<string, string | undefined>): AnalysisConfig {
  const list = (v?: string) => (v ? v.split(',').filter(Boolean) : undefined)
  const filters: AnalysisFilters = {
    dataset: list(params.dataset),
    harness: list(params.harness),
    model: list(params.model),
    status: list(params.status),
    owner: list(params.owner),
    originSource: list(params.origin),
    from: params.from,
    to: params.to,
  }
  const groupBy = (list(params.group) ?? DEFAULT_CONFIG.groupBy).filter(isDim).slice(0, 2)
  const pivotBy = params.pivot && isDim(params.pivot) ? params.pivot : undefined
  const measure: Measure = (['passRate', 'mean', 'count', 'latest'] as Measure[]).includes(
    params.measure as Measure
  )
    ? (params.measure as Measure)
    : 'passRate'
  const viz: Viz = (['table', 'bars', 'line'] as Viz[]).includes(params.viz as Viz)
    ? (params.viz as Viz)
    : 'table'
  const [sortBy, sortDir] = (params.sort ?? 'measure:desc').split(':')
  return {
    filters,
    groupBy: groupBy.length ? groupBy : DEFAULT_CONFIG.groupBy,
    ...(pivotBy ? { pivotBy } : {}),
    ...(params.metric ? { metric: params.metric } : {}),
    measure,
    sort: {
      by: sortBy === 'label' ? 'label' : 'measure',
      dir: sortDir === 'asc' ? 'asc' : 'desc',
    },
    ...(params.q ? { search: params.q } : {}),
    viz,
    ...(params.incomplete === '1' ? { includeIncomplete: true } : {}),
  }
}
