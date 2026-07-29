'use client'

import { useEffect, useMemo, useState } from 'react'
import { Link2, Search } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { ScorecardRecord } from '@/entities/scorecard'
import type { View } from '@/entities/view'
import {
  fmtMetricLabel,
  fmtPct,
  fmtScore,
  fmtSubject,
  HEALTH_TEXT,
  rateHealth,
} from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import {
  LineChart,
  MAX_SERIES,
  RankedBars,
  seriesColorAt,
  type ChartSeries,
} from '@/shared/ui/charts'
import { Combobox, type ComboboxOption } from '@/shared/ui/combobox'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input } from '@/shared/ui/input'
import { StatCard } from '@/shared/ui/stat-card'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

import {
  computeAnalysis,
  configToParams,
  configToStored,
  DIMENSION_KEY,
  dimValue,
  filterScorecards,
  groupKeyOf,
  MEASURE_KEY,
  metricsOf,
  seriesDimensionOf,
  storedToConfig,
  timeDimensionOf,
  type AnalysisConfig,
  type Dimension,
  type Measure,
  type Viz,
} from '../model/analysis'
import { RawRowsTable } from './raw-rows-table'
import { SavedViewsBar } from './saved-views-bar'

type Author = { name: string; avatarUrl?: string }

// What the raw-data table is scoped to after a mark is clicked: one group row (grid key) or one time bucket.
type Focus = { kind: 'group' | 'bucket'; key: string; label: string }

const GROUP_DIMS: Dimension[] = [
  'harness',
  'harnessVersion',
  'model',
  'dataset',
  'datasetVersion',
  'judgeModel',
  'status',
  'originSource',
  'repo',
  'owner',
  'day',
  'week',
  'month',
]

const VIZ: { value: Viz; labelKey: string }[] = [
  { value: 'table', labelKey: 'vizTable' },
  { value: 'bars', labelKey: 'vizBars' },
  { value: 'line', labelKey: 'trend' },
]

// Presets — "build all 4 lenses from this one dashboard" in a single click.
const PRESETS: { labelKey: string; patch: Partial<AnalysisConfig> }[] = [
  {
    labelKey: 'presetLeaderboard',
    patch: {
      groupBy: ['harness', 'model'],
      measure: 'passRate',
      viz: 'bars',
      sort: { by: 'measure', dir: 'desc' },
    },
  },
  {
    labelKey: 'presetByHarness',
    patch: { groupBy: ['harness'], pivotBy: 'dataset', measure: 'passRate', viz: 'table' },
  },
  {
    labelKey: 'trend',
    patch: {
      groupBy: ['day', 'harness'],
      measure: 'passRate',
      viz: 'line',
      sort: { by: 'label', dir: 'asc' },
    },
  },
  {
    labelKey: 'presetVersionCompare',
    patch: {
      groupBy: ['harnessVersion'],
      measure: 'passRate',
      viz: 'table',
      sort: { by: 'label', dir: 'asc' },
    },
  },
]

function measureCell(value: number | undefined, measure: Measure) {
  if (value === undefined) return <span className="text-faint">–</span>
  if (measure === 'count') return <span className="tabular-nums">{value}</span>
  const health = rateHealth(value <= 1 ? value : null)
  return (
    <span className={cn('font-[560] tabular-nums', HEALTH_TEXT[health])}>
      {measure === 'mean' ? value.toFixed(2) : fmtScore(value, value)}
    </span>
  )
}

// Flexible scorecard analysis dashboard — compose leaderboard/by-harness/trend/compare on one screen via filter/group/measure/search.
// Save a composed analysis as a named View (private|shared); opening a saved view re-runs it against current data (live).
export function CustomAnalyzer({
  scorecards,
  authors,
  initialConfig,
  savedViews = [],
  currentSubject = '',
  canManage = false,
  isAdmin = false,
  activeViewId,
}: {
  scorecards: ScorecardRecord[]
  authors: Record<string, Author>
  initialConfig: AnalysisConfig
  savedViews?: View[]
  currentSubject?: string
  canManage?: boolean
  isAdmin?: boolean
  activeViewId?: string
}) {
  const t = useTranslations('analyzeScorecards')
  const [config, setConfig] = useState<AnalysisConfig>(initialConfig)
  const [copied, setCopied] = useState(false)
  // Drill-down target: the group row / time bucket whose underlying records the raw table is scoped to.
  const [focus, setFocus] = useState<Focus>()

  // config → URL (no navigation) — for deep-linking/sharing.
  useEffect(() => {
    const p = configToParams(config)
    window.history.replaceState(null, '', `?${p.toString()}`)
  }, [config])

  // The agent drove the canvas (apply_view_config in the chat panel, same window) — apply the streamed
  // stored-form config live. storedToConfig normalizes defensively, so a malformed payload degrades to defaults;
  // the member keeps full manual control afterwards (this is just another setConfig).
  useEffect(() => {
    const onApply = (e: Event) => {
      const detail = (e as CustomEvent<unknown>).detail
      if (detail !== null && typeof detail === 'object') setConfig(storedToConfig(detail))
    }
    window.addEventListener('everdict:view-config', onApply)
    return () => window.removeEventListener('everdict:view-config', onApply)
  }, [])

  // Canvas-state feedback, the reverse direction: the agent chat asks what the canvas CURRENTLY shows right
  // before sending each turn (synchronous same-window request/response), so multi-turn refinement — "make it
  // a bar chart", "regroup by model" — grounds on the live state including the member's manual picker changes.
  // The same state is also announced unprompted on mount and on every change, so the chat composer can show a
  // live "canvas linked" chip (presence, not just per-send capture).
  const activeViewName = savedViews.find((v) => v.id === activeViewId)?.name
  useEffect(() => {
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent('everdict:canvas-state', {
          detail: {
            config: configToStored(config),
            ...(activeViewId ? { viewId: activeViewId } : {}),
            ...(activeViewName ? { viewName: activeViewName } : {}),
          },
        })
      )
    announce()
    window.addEventListener('everdict:canvas-state-request', announce)
    return () => window.removeEventListener('everdict:canvas-state-request', announce)
  }, [config, activeViewId, activeViewName])

  // Departure — real unmount only ([] deps): the member left the canvas, so the chat's "canvas linked" chip
  // must clear (and the next turn carries no canvas).
  useEffect(() => {
    return () => {
      window.dispatchEvent(new CustomEvent('everdict:canvas-state', { detail: null }))
    }
  }, [])

  const resolveOwner = (s: string) => authors[s]?.name ?? (s ? fmtSubject(s) : '—')
  const patch = (p: Partial<AnalysisConfig>) => setConfig((c) => ({ ...c, ...p }))
  const setFilter = (k: keyof AnalysisConfig['filters'], v: string) =>
    setConfig((c) => ({
      ...c,
      filters: { ...c.filters, [k]: v ? [v] : undefined },
    }))

  // Option lists (derived from the scorecards).
  const opts = useMemo(() => {
    const uniq = (fn: (sc: ScorecardRecord) => string) =>
      [...new Set(scorecards.map(fn))].filter((v) => v && v !== '—').sort()
    return {
      dataset: uniq((s) => s.dataset.id),
      harness: uniq((s) => s.harness.id),
      model: uniq((s) => dimValue(s, 'model')),
      judgeModel: uniq((s) => dimValue(s, 'judgeModel')),
      status: uniq((s) => s.status),
      origin: uniq((s) => dimValue(s, 'originSource')),
      owner: [...new Set(scorecards.map((s) => s.createdBy ?? '').filter(Boolean))],
    }
  }, [scorecards])
  const metrics = useMemo(() => metricsOf(scorecards), [scorecards])

  const result = useMemo(
    () => computeAnalysis(scorecards, config, resolveOwner, t('all')),
    [scorecards, config, authors, t]
  )

  // Re-shaping the analysis invalidates a drill-down key, so the focus goes with it.
  const shapeKey = `${config.groupBy.join(',')}:${config.viz}`
  useEffect(() => setFocus(undefined), [shapeKey])

  // The records the aggregate was computed from — the raw table below, scoped to the focused mark.
  const rawRows = useMemo(
    () => filterScorecards(scorecards, config, resolveOwner),
    [scorecards, config, authors]
  )
  const focusedRows = useMemo(() => {
    if (!focus) return rawRows
    if (focus.kind === 'bucket') {
      const dim = timeDimensionOf(config)
      return rawRows.filter((sc) => dimValue(sc, dim) === focus.key)
    }
    return rawRows.filter((sc) => groupKeyOf(sc, config.groupBy) === focus.key)
  }, [rawRows, focus, config])

  // Slots are dealt over the WHOLE dataset's values for the series dimension, never over the filtered
  // result — so narrowing a filter never repaints the survivors and an entity keeps its hue.
  const seriesColorOf = useMemo(() => {
    const map = new Map<string, string>()
    const dim = seriesDimensionOf(config)
    if (!dim) return map
    const all = [...new Set(scorecards.map((sc) => dimValue(sc, dim)))].sort()
    all.forEach((raw, i) => map.set(dim === 'owner' ? resolveOwner(raw) : raw, seriesColorAt(i)))
    return map
  }, [scorecards, config, authors])

  // A measure whose values all sit inside 0~1 is a ratio: pin the axis to 0–100% so a bar's length means the
  // same thing across re-filters. Everything else scales to its own range instead of a hardcoded ceiling.
  const measureValues =
    result.kind === 'line'
      ? result.series.flatMap((s) => s.points).filter((v): v is number => v !== undefined)
      : result.rows
          .flatMap((r) => (r.cells.length > 0 ? r.cells.map((c) => c.value) : [r.value]))
          .filter((v): v is number => v !== undefined)
  const isRatio =
    config.measure !== 'count' &&
    measureValues.length > 0 &&
    measureValues.every((v) => v >= 0 && v <= 1)
  const ratioDomain = isRatio ? { min: 0, max: 1 } : undefined
  const formatMeasure = (v: number) =>
    config.measure === 'count' ? v.toLocaleString() : isRatio ? fmtPct(v) : v.toFixed(2)

  const focusGroup = (key: string, label: string) => setFocus({ kind: 'group', key, label })

  const filterCombo = (
    label: string,
    key: keyof AnalysisConfig['filters'],
    values: string[],
    render?: (v: string) => string
  ) => {
    const options: ComboboxOption[] = [
      { value: '', label: t('filterAll', { label }) },
      ...values.map((v) => ({ value: v, label: render ? render(v) : v })),
    ]
    return (
      <Combobox
        options={options}
        value={config.filters[key]?.[0] ?? ''}
        onChange={(v) => setFilter(key, v)}
        placeholder={label}
        className="w-[150px]"
      />
    )
  }

  const dimCombo = (
    value: Dimension | '',
    onChange: (v: Dimension | '') => void,
    placeholder: string,
    exclude: (Dimension | undefined)[] = []
  ) => (
    <Combobox
      options={[
        { value: '', label: placeholder },
        ...GROUP_DIMS.filter((d) => !exclude.includes(d)).map((d) => ({
          value: d,
          label: t(DIMENSION_KEY[d]),
        })),
      ]}
      value={value}
      onChange={(v) => onChange(v as Dimension | '')}
      placeholder={placeholder}
      searchable={false}
      className="w-[130px]"
    />
  )

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  return (
    <div className="space-y-4">
      <SavedViewsBar
        config={config}
        onLoad={setConfig}
        savedViews={savedViews}
        currentSubject={currentSubject}
        canManage={canManage}
        isAdmin={isAdmin}
        activeViewId={activeViewId}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label={t('statScorecards')} value={result.total} hint={t('filterApplied')} />
        <StatCard label={t('statBenchmarks')} value={opts.dataset.length} />
        <StatCard label={t('statHarnesses')} value={opts.harness.length} />
        <StatCard label={t('statModels')} value={opts.model.length} />
      </div>

      {/* presets + search + visualization + link */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-[510] uppercase tracking-wide text-faint">
          {t('presetLabel')}
        </span>
        {PRESETS.map((p) => (
          <button
            key={p.labelKey}
            type="button"
            onClick={() => patch(p.patch)}
            className="rounded-md border border-border bg-card px-2.5 py-1 text-[12px] font-[510] text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
          >
            {t(p.labelKey)}
          </button>
        ))}
        <div className="relative ml-auto min-w-[160px] flex-1 sm:flex-none">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={config.search ?? ''}
            onChange={(e) => patch({ search: e.target.value || undefined })}
            placeholder={t('searchPlaceholder')}
            className="pl-8"
            aria-label={t('searchAria')}
          />
        </div>
        <button
          type="button"
          onClick={copyLink}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
        >
          <Link2 className="size-3.5" />
          {copied ? t('copied') : t('link')}
        </button>
      </div>

      {/* filters */}
      <div className="flex flex-wrap items-center gap-2">
        {filterCombo(t('filterBenchmark'), 'dataset', opts.dataset)}
        {filterCombo(t('harness'), 'harness', opts.harness)}
        {filterCombo(t('filterModel'), 'model', opts.model)}
        {opts.judgeModel.length > 0 &&
          filterCombo(t('filterJudgeModel'), 'judgeModel', opts.judgeModel)}
        {filterCombo(t('filterStatus'), 'status', opts.status)}
        {opts.owner.length > 0 && filterCombo(t('filterOwner'), 'owner', opts.owner, resolveOwner)}
        {opts.origin.length > 0 && filterCombo(t('filterOrigin'), 'originSource', opts.origin)}
        <Input
          type="date"
          value={config.filters.from ?? ''}
          onChange={(e) =>
            setConfig((c) => ({
              ...c,
              filters: { ...c.filters, from: e.target.value || undefined },
            }))
          }
          className="w-[140px]"
          aria-label={t('dateFrom')}
        />
        <Input
          type="date"
          value={config.filters.to ?? ''}
          onChange={(e) =>
            setConfig((c) => ({ ...c, filters: { ...c.filters, to: e.target.value || undefined } }))
          }
          className="w-[140px]"
          aria-label={t('dateTo')}
        />
        {/* Include superseded/incomplete cards (excluded by default) — round-trips into a saved View. */}
        <label className="flex cursor-pointer items-center gap-1.5 text-[12px] font-[510] text-muted-foreground">
          <input
            type="checkbox"
            className="accent-primary"
            checked={config.includeIncomplete ?? false}
            onChange={(e) =>
              setConfig((c) => ({ ...c, includeIncomplete: e.target.checked || undefined }))
            }
          />
          {t('includeIncomplete')}
        </label>
      </div>

      {/* shape (group·pivot·measure·sort·visualization) */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card/60 p-2.5">
        <span className="text-[11px] font-[510] uppercase tracking-wide text-faint">
          {t('group')}
        </span>
        {dimCombo(
          config.groupBy[0] ?? '',
          (v) =>
            patch({
              groupBy: v
                ? [v, ...(config.groupBy[1] ? [config.groupBy[1]] : [])]
                : config.groupBy.slice(1),
            }),
          t('group1'),
          [config.groupBy[1]]
        )}
        {dimCombo(
          config.groupBy[1] ?? '',
          (v) => patch({ groupBy: [config.groupBy[0] ?? 'harness', ...(v ? [v] : [])] }),
          t('group2'),
          [config.groupBy[0]]
        )}
        <span className="text-[11px] font-[510] uppercase tracking-wide text-faint">
          {t('column')}
        </span>
        {dimCombo(
          config.pivotBy ?? '',
          (v) => patch({ pivotBy: v || undefined }),
          t('pivotOptional'),
          config.groupBy
        )}
        <span className="text-[11px] font-[510] uppercase tracking-wide text-faint">
          {t('measure')}
        </span>
        <Combobox
          options={(Object.keys(MEASURE_KEY) as Measure[]).map((m) => ({
            value: m,
            label: t(MEASURE_KEY[m]),
          }))}
          value={config.measure}
          onChange={(v) => patch({ measure: v as Measure })}
          searchable={false}
          className="w-[120px]"
        />
        {metrics.length > 1 && (
          <Combobox
            options={[
              { value: '', label: t('defaultMetric') },
              // Judge metrics render human-readably ('judge <id> › <criterion>') — the full workspace metric list is the disambiguation context.
              ...metrics.map((m) => ({ value: m, label: fmtMetricLabel(m, metrics) })),
            ]}
            value={config.metric ?? ''}
            onChange={(v) => patch({ metric: v || undefined })}
            className="w-[140px]"
          />
        )}
        <button
          type="button"
          onClick={() =>
            patch({
              sort: { by: config.sort.by, dir: config.sort.dir === 'desc' ? 'asc' : 'desc' },
            })
          }
          className="rounded-md border border-border bg-card px-2 py-1.5 text-[12px] text-muted-foreground hover:text-foreground"
        >
          {t('sort')} {config.sort.dir === 'desc' ? '↓' : '↑'}
        </button>
        <div className="ml-auto inline-flex overflow-hidden rounded-lg border bg-card">
          {VIZ.map((v, i) => (
            <button
              key={v.value}
              type="button"
              onClick={() => patch({ viz: v.value })}
              className={cn(
                'px-2.5 py-1.5 text-[12px] font-[510] transition-colors',
                i > 0 && 'border-l border-border',
                config.viz === v.value
                  ? 'bg-secondary text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {t(v.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* results — every mark is a drill-down handle into the raw rows below */}
      {result.total === 0 ? (
        <EmptyState title={t('customEmptyTitle')} hint={t('customEmptyHint')} />
      ) : result.kind === 'line' ? (
        (() => {
          // Past the palette's slots we do NOT invent hues — the tail is left out and said so out loud.
          const shown = result.series.slice(0, MAX_SERIES)
          const hidden = result.series.length - shown.length
          const series: ChartSeries[] = shown.map((s) => ({
            key: s.label,
            label: s.label,
            color: seriesColorOf.get(s.label) ?? seriesColorAt(0),
          }))
          return (
            <div className="rounded-lg border bg-card p-4 shadow-raise">
              <LineChart
                x={result.buckets}
                series={series}
                values={shown.map((s) => s.points)}
                formatValue={formatMeasure}
                formatX={(label) => (label.length > 7 ? label.slice(5) : label)}
                {...(ratioDomain ? { domain: ratioDomain } : {})}
                ariaLabel={t('scoreTrend')}
                emptyLabel={t('customEmptyTitle')}
                onSelect={(i) => {
                  const bucket = result.buckets[i]
                  if (bucket) setFocus({ kind: 'bucket', key: bucket, label: bucket })
                }}
              />
              {hidden > 0 && (
                <p className="mt-2 text-[11px] text-faint">
                  {t('seriesCapped', { hidden, max: MAX_SERIES })}
                </p>
              )}
            </div>
          )
        })()
      ) : config.viz === 'bars' ? (
        <div className="rounded-lg border bg-card p-3.5 shadow-raise">
          <RankedBars
            rows={result.rows.map((r) => ({
              key: r.key,
              label: r.labels.join(' · ') || t('all'),
              ...(r.value !== undefined ? { value: r.value } : {}),
              count: r.count,
            }))}
            formatValue={formatMeasure}
            {...(ratioDomain ? { domain: ratioDomain } : {})}
            renderValue={(row) => measureCell(row.value, config.measure)}
            countLabel={(count) => t('countUnit', { count })}
            emptyLabel={t('customEmptyTitle')}
            {...(focus?.kind === 'group' ? { selectedKey: focus.key } : {})}
            onSelect={(row) => focusGroup(row.key, row.label)}
          />
        </div>
      ) : (
        <Table>
          <THead>
            <tr>
              {config.groupBy.map((d) => (
                <TH key={d}>{t(DIMENSION_KEY[d])}</TH>
              ))}
              {result.pivotKeys.length > 0 ? (
                result.pivotKeys.map((pk) => (
                  <TH key={pk} className="text-right">
                    {pk}
                  </TH>
                ))
              ) : (
                <TH className="text-right">{t(MEASURE_KEY[config.measure])}</TH>
              )}
              {/* Two different numbers, and readers conflate them: how many runs went into the row, and how
                  many scored cases the rate was weighted over. A rate without its n can't be judged. */}
              <TH className="text-right">{t('countHeader')}</TH>
              <TH className="text-right">{t('casesHeader')}</TH>
            </tr>
          </THead>
          <TBody>
            {result.rows.map((r) => {
              const label = r.labels.join(' · ') || t('all')
              return (
                <TR
                  key={r.key}
                  role="button"
                  tabIndex={0}
                  aria-label={label}
                  className={cn(
                    'cursor-pointer',
                    focus?.kind === 'group' && focus.key === r.key && 'bg-elevated'
                  )}
                  onClick={() => focusGroup(r.key, label)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      focusGroup(r.key, label)
                    }
                  }}
                >
                  {r.labels.map((l, i) => (
                    <TD key={i} className="font-[510]">
                      {l || '—'}
                    </TD>
                  ))}
                  {result.pivotKeys.length > 0 ? (
                    r.cells.map((c) => (
                      <TD key={c.key} className="text-right">
                        {measureCell(c.value, config.measure)}
                      </TD>
                    ))
                  ) : (
                    <TD className="text-right">{measureCell(r.value, config.measure)}</TD>
                  )}
                  <TD className="text-right text-[11px] text-faint">{r.count}</TD>
                  <TD className="text-right text-[11px] tabular-nums text-faint">
                    {r.cases.toLocaleString()}
                  </TD>
                </TR>
              )
            })}
          </TBody>
        </Table>
      )}

      <p className="text-[11px] text-faint">
        {t('customSummary', { total: result.total })}
        {config.measure === 'passRate' ? t('customSummaryPassRate', { pct: fmtPct(1) }) : ''}
      </p>

      {/* The records behind the aggregate — the chart's table-view twin, and where a clicked mark lands. */}
      <RawRowsTable
        rows={focusedRows}
        {...(config.metric ? { metric: config.metric } : {})}
        {...(focus ? { focusLabel: focus.label, onClearFocus: () => setFocus(undefined) } : {})}
      />
    </div>
  )
}
