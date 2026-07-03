import type { ScorecardRecord } from '@/entities/scorecard'

// 스코어카드 유연 분석 엔진 — listScorecards 배열 위의 순수 피벗(필터·그룹·측정·정렬·검색).
// 리더보드/하니스별/추이/비교는 전부 이 config 의 구성으로 재현된다. 설계: docs/architecture/scorecard-analysis-views.md.

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

export const DIMENSION_LABEL: Record<Dimension, string> = {
  dataset: '벤치마크',
  datasetVersion: '벤치마크 버전',
  harness: '하니스',
  harnessVersion: '하니스 버전',
  model: '모델',
  judgeModel: 'Judge 모델',
  status: '상태',
  originSource: '실행 출처',
  repo: '레포',
  owner: '실행자',
  day: '일',
  week: '주',
  month: '월',
}

export type Measure = 'passRate' | 'mean' | 'count' | 'latest'
export const MEASURE_LABEL: Record<Measure, string> = {
  passRate: '통과율',
  mean: '평균',
  count: '건수',
  latest: '최신 점수',
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
  groupBy: Dimension[] // 0..2 dims → 그룹 행
  pivotBy?: Dimension // 선택 열 차원 → 매트릭스
  metric?: string // 어느 summary metric (미지정=가장 흔한 것)
  measure: Measure
  sort: { by: 'measure' | 'label'; dir: 'asc' | 'desc' }
  search?: string
  viz: Viz
  includeIncomplete?: boolean // superseded/미완료 포함(기본 제외)
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
  // ISO week 근사 — YYYY-Www (표시용). 목요일 기준.
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day + 3)
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  const week =
    1 +
    Math.round(
      ((d.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
    )
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

// 한 스코어카드의 차원 값(원시 — owner 는 subject; 표시 이름은 렌더에서 resolve).
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

// 이 스코어카드의 점수(선택 metric) — passRate 우선, 없으면 mean.
function scoreOf(sc: ScorecardRecord, metric: string | undefined): number | undefined {
  const rows = sc.summary ?? []
  const row = (metric ? rows.find((r) => r.metric === metric) : undefined) ?? rows[0]
  if (!row) return undefined
  return row.passRate ?? row.mean
}

// 그룹(스코어카드 묶음)의 측정값.
function aggregate(cards: ScorecardRecord[], metric: string | undefined, measure: Measure): number | undefined {
  if (cards.length === 0) return undefined
  if (measure === 'count') return cards.length
  if (measure === 'latest') {
    const latest = [...cards].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    return latest ? scoreOf(latest, metric) : undefined
  }
  // passRate | mean — 각 카드 점수의 평균(정의된 것만)
  const vals = cards.map((c) => scoreOf(c, metric)).filter((v): v is number => v !== undefined)
  if (vals.length === 0) return undefined
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

// 워크스페이스의 모든 metric 이름(빈도순) + 기본 metric.
export function metricsOf(scorecards: ScorecardRecord[]): string[] {
  const freq = new Map<string, number>()
  for (const sc of scorecards) for (const s of sc.summary ?? []) freq.set(s.metric, (freq.get(s.metric) ?? 0) + 1)
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m)
}

// 필터 통과?
function passesFilters(sc: ScorecardRecord, c: AnalysisConfig, resolveOwner: (s: string) => string): boolean {
  const f = c.filters
  if (!c.includeIncomplete && (sc.status === 'superseded' || sc.status === 'queued' || sc.status === 'running'))
    return false
  const inList = (list: string[] | undefined, v: string) => !list || list.length === 0 || list.includes(v)
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
  labels: string[] // groupBy 차원별 라벨(표시용, owner 는 resolve됨)
  count: number
  value?: number // pivot 없을 때의 측정값
  cells: { key: string; value?: number }[] // pivot 열별 값
}
export interface GridResult {
  kind: 'grid'
  rows: GridRow[]
  pivotKeys: string[] // pivotBy 값들(정렬됨); 없으면 []
  metric?: string
  total: number // 필터 통과한 스코어카드 수
}
export interface LineResult {
  kind: 'line'
  buckets: string[] // 시간 버킷(정렬)
  series: { label: string; points: (number | undefined)[] }[]
  metric?: string
  total: number
}
export type AnalysisResult = GridResult | LineResult

function groupKey(sc: ScorecardRecord, dims: Dimension[]): string {
  return dims.map((d) => dimValue(sc, d)).join('')
}

// 메인 — 스코어카드 배열 + config → 결과(grid|line). resolveOwner: subject→표시이름.
export function computeAnalysis(
  scorecards: ScorecardRecord[],
  config: AnalysisConfig,
  resolveOwner: (s: string) => string = (s) => s
): AnalysisResult {
  const filtered = scorecards.filter((sc) => passesFilters(sc, config, resolveOwner))
  const metric = config.metric
  const labelOf = (dim: Dimension, raw: string) => (dim === 'owner' ? resolveOwner(raw) : raw)

  if (config.viz === 'line') {
    // x축 = groupBy 의 시간 차원(첫 번째), series = 나머지 groupBy 차원(있으면).
    const timeDim = config.groupBy.find((d) => TIME_DIMENSIONS.includes(d)) ?? 'day'
    const seriesDim = config.groupBy.find((d) => !TIME_DIMENSIONS.includes(d))
    const buckets = [...new Set(filtered.map((sc) => dimValue(sc, timeDim)))].sort()
    const seriesKeys = seriesDim
      ? [...new Set(filtered.map((sc) => dimValue(sc, seriesDim)))].sort()
      : ['전체']
    const series = seriesKeys.map((sk) => ({
      label: seriesDim ? labelOf(seriesDim, sk) : '전체',
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
    return { key, labels, count: cards.length, value: aggregate(cards, metric, config.measure), cells }
  })

  const dir = config.sort.dir === 'asc' ? 1 : -1
  rows = rows.sort((a, b) => {
    if (config.sort.by === 'label') return dir * a.labels.join(' ').localeCompare(b.labels.join(' '))
    const av = a.value ?? -Infinity
    const bv = b.value ?? -Infinity
    return dir * (av - bv)
  })

  return { kind: 'grid', rows, pivotKeys, metric, total: filtered.length }
}

// ── URL 코덱 (config ↔ query) — 딥링크/공유용. ────────────────────────────────
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

const DIMS = new Set<string>(Object.keys(DIMENSION_LABEL))
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
