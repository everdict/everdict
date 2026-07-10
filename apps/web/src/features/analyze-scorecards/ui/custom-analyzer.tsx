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
import { Combobox, type ComboboxOption } from '@/shared/ui/combobox'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input } from '@/shared/ui/input'
import { StatCard } from '@/shared/ui/stat-card'

import {
  computeAnalysis,
  configToParams,
  DIMENSION_KEY,
  dimValue,
  MEASURE_KEY,
  metricsOf,
  type AnalysisConfig,
  type Dimension,
  type Measure,
  type Viz,
} from '../model/analysis'
import { SavedViewsBar } from './saved-views-bar'

type Author = { name: string; avatarUrl?: string }

const GROUP_DIMS: Dimension[] = [
  'harness',
  'harnessVersion',
  'model',
  'dataset',
  'datasetVersion',
  'judgeModel',
  'status',
  'originSource',
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

// Multi-series line chart (trend). Values are scaled 0~100% if assumed to be 0~1 (pass rate), otherwise min~max normalized.
function LineChart({
  buckets,
  series,
}: {
  buckets: string[]
  series: { label: string; points: (number | undefined)[] }[]
}) {
  const t = useTranslations('analyzeScorecards')
  const W = 720
  const H = 200
  const pad = { l: 8, r: 8, t: 10, b: 22 }
  const all = series.flatMap((s) => s.points).filter((v): v is number => v !== undefined)
  const max = Math.max(1, ...all)
  const min = Math.min(0, ...all)
  const span = max - min || 1
  const n = buckets.length
  const x = (i: number) => pad.l + (n <= 1 ? 0 : (i * (W - pad.l - pad.r)) / (n - 1))
  const y = (v: number) => pad.t + (1 - (v - min) / span) * (H - pad.t - pad.b)
  const COLORS = [
    'var(--color-primary)',
    'var(--color-success)',
    'var(--color-warning)',
    '#4ea7ff',
    '#eb5757',
  ]
  return (
    <div className="space-y-2 overflow-x-auto rounded-lg border bg-card p-4 shadow-raise">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-52 w-full min-w-[520px]"
        role="img"
        aria-label={t('scoreTrend')}
      >
        {series.map((s, si) => {
          const pts = s.points
            .map((v, i) => (v === undefined ? null : `${x(i)},${y(v)}`))
            .filter(Boolean)
            .join(' ')
          return (
            <polyline
              key={s.label}
              points={pts}
              fill="none"
              stroke={COLORS[si % COLORS.length]}
              strokeWidth={2}
              strokeLinejoin="round"
            />
          )
        })}
        {buckets.map((b, i) => (
          <text
            key={b}
            x={x(i)}
            y={H - 6}
            textAnchor="middle"
            className="fill-[var(--color-faint)] text-[9px]"
          >
            {b.length > 7 ? b.slice(5) : b}
          </text>
        ))}
      </svg>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {series.map((s, si) => (
          <span key={s.label} className="inline-flex items-center gap-1 text-muted-foreground">
            <span
              className="inline-block size-2 rounded-full"
              style={{ background: COLORS[si % COLORS.length] }}
            />
            {s.label}
          </span>
        ))}
      </div>
    </div>
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

  // config → URL (no navigation) — for deep-linking/sharing. Keep mode=custom (restore custom mode on refresh).
  useEffect(() => {
    const p = configToParams(config)
    p.set('mode', 'custom')
    window.history.replaceState(null, '', `?${p.toString()}`)
  }, [config])

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

      {/* results */}
      {result.total === 0 ? (
        <EmptyState title={t('customEmptyTitle')} hint={t('customEmptyHint')} />
      ) : result.kind === 'line' ? (
        <LineChart buckets={result.buckets} series={result.series} />
      ) : config.viz === 'bars' ? (
        <div className="space-y-1.5 rounded-lg border bg-card p-3.5 shadow-raise">
          {result.rows.map((r) => {
            const v = r.value ?? 0
            const pct = v <= 1 ? v : 0
            return (
              <div key={r.key} className="flex items-center gap-3">
                <span
                  className="w-48 shrink-0 truncate text-[13px] font-[510]"
                  title={r.labels.join(' · ')}
                >
                  {r.labels.join(' · ') || t('all')}
                </span>
                <div className="relative h-5 flex-1 overflow-hidden rounded bg-secondary/50">
                  <div
                    className="h-full rounded bg-primary/60"
                    style={{ width: `${Math.round(pct * 100)}%` }}
                  />
                </div>
                <span className="w-16 shrink-0 text-right">
                  {measureCell(r.value, config.measure)}
                </span>
                <span className="w-10 shrink-0 text-right text-[11px] text-faint">
                  {t('countUnit', { count: r.count })}
                </span>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card shadow-raise">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-faint">
                {config.groupBy.map((d) => (
                  <th key={d} className="px-3 py-2 font-[510]">
                    {t(DIMENSION_KEY[d])}
                  </th>
                ))}
                {result.pivotKeys.length > 0 ? (
                  result.pivotKeys.map((pk) => (
                    <th key={pk} className="px-3 py-2 text-right font-[510]">
                      {pk}
                    </th>
                  ))
                ) : (
                  <th className="px-3 py-2 text-right font-[510]">
                    {t(MEASURE_KEY[config.measure])}
                  </th>
                )}
                <th className="px-3 py-2 text-right font-[510]">{t('countHeader')}</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r) => (
                <tr
                  key={r.key}
                  className="border-b border-border/60 last:border-0 hover:bg-elevated"
                >
                  {r.labels.map((l, i) => (
                    <td key={i} className="px-3 py-2 font-[510] text-foreground">
                      {l || '—'}
                    </td>
                  ))}
                  {result.pivotKeys.length > 0 ? (
                    r.cells.map((c) => (
                      <td key={c.key} className="px-3 py-2 text-right">
                        {measureCell(c.value, config.measure)}
                      </td>
                    ))
                  ) : (
                    <td className="px-3 py-2 text-right">{measureCell(r.value, config.measure)}</td>
                  )}
                  <td className="px-3 py-2 text-right text-[11px] text-faint">{r.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-faint">
        {t('customSummary', { total: result.total })}
        {config.measure === 'passRate' ? t('customSummaryPassRate', { pct: fmtPct(1) }) : ''}
      </p>
    </div>
  )
}
