'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Sparkles } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { ScorecardRecord } from '@/entities/scorecard'
import type { View } from '@/entities/view'
import { fmtPct, fmtScore, fmtSubject, HEALTH_TEXT, rateHealth } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import {
  LineChart,
  MAX_SERIES,
  RankedBars,
  seriesColorAt,
  type ChartSeries,
} from '@/shared/ui/charts'
import { EmptyState } from '@/shared/ui/empty-state'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

import {
  computeAnalysis,
  configToParams,
  configToStored,
  describeConfig,
  DIMENSION_KEY,
  dimValue,
  filterScorecards,
  groupKeyOf,
  MEASURE_KEY,
  seriesDimensionOf,
  storedToConfig,
  timeDimensionOf,
  type AnalysisConfig,
  type Measure,
} from '../model/analysis'
import { RawRowsTable } from './raw-rows-table'
import { SaveAnalysisButton } from './save-analysis-button'

type Author = { name: string; avatarUrl?: string }

// What the raw-data table is scoped to after a mark is clicked: one group row (grid key) or one time bucket.
type Focus = { kind: 'group' | 'bucket'; key: string; label: string }

function measureCell(value: number | undefined, measure: Measure) {
  if (value === undefined) return <span className="text-faint">–</span>
  if (measure === 'count') return <span className="tabular-nums">{value}</span>
  // Only the passRate measure is a rate by construction — 'latest' carries whatever the card's representative
  // value was (a pass rate OR a raw mean), so forcing it through the percent renderer turned a $0.42 mean
  // into "42%". Ambiguous values render as plain numbers; only a known rate gets the % form and health color.
  const isRate = measure === 'passRate'
  const health = rateHealth(isRate ? value : null)
  return (
    <span className={cn('font-[560] tabular-nums', HEALTH_TEXT[health])}>
      {isRate ? fmtScore(value, null) : value.toFixed(2)}
    </span>
  )
}

// The analysis canvas — the conversation's drawing surface (docs/architecture/analysis-studio.md C).
// It starts BLANK and carries no chrome of its own: no stat tiles, no presets, no search, no filter/shape
// pickers. A new analysis IS a conversation, and the agent's apply_view_config is what puts the first lens on
// the screen; a saved View or a shared deep link fills it on arrival instead. The member's only canvas-side
// action is keeping what the conversation drew (save it as a View) — everything else is said, not clicked.
export function CustomAnalyzer({
  scorecards,
  authors,
  initialConfig,
  savedViews = [],
  currentSubject = '',
  canManage = false,
  isAdmin = false,
  activeViewId,
  emptyAction,
}: {
  scorecards: ScorecardRecord[]
  authors: Record<string, Author>
  /** The lens to draw on arrival — a saved View or a deep link. Absent = a blank canvas awaiting the conversation. */
  initialConfig?: AnalysisConfig
  savedViews?: View[]
  currentSubject?: string
  canManage?: boolean
  isAdmin?: boolean
  activeViewId?: string
  /** The blank canvas's call to action (the page passes the agent entry — a feature cannot reach the panel). */
  emptyAction?: ReactNode
}) {
  const t = useTranslations('analyzeScorecards')
  const [config, setConfig] = useState<AnalysisConfig | undefined>(initialConfig)

  // config → URL (no navigation) — for deep-linking/sharing.
  useEffect(() => {
    if (!config) return
    const p = configToParams(config)
    window.history.replaceState(null, '', `?${p.toString()}`)
  }, [config])

  // The agent drove the canvas (apply_view_config in the chat panel, same window) — apply the streamed
  // stored-form config live. storedToConfig normalizes defensively, so a malformed payload degrades to defaults.
  // This is the ONLY way a blank canvas gets its first lens.
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
  // a bar chart", "regroup by model" — grounds on the live state. A BLANK canvas announces an empty config
  // rather than staying silent: "the canvas is open and empty" is exactly what the first turn must know.
  // The same state is also announced unprompted on mount and on every change, so the chat composer can show a
  // live "canvas linked" chip (presence, not just per-send capture).
  const activeView = savedViews.find((v) => v.id === activeViewId)
  const activeViewName = activeView?.name
  useEffect(() => {
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent('everdict:canvas-state', {
          detail: {
            config: config ? configToStored(config) : {},
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

  if (!config)
    return (
      <EmptyState
        icon={<Sparkles />}
        title={t('canvasEmptyTitle')}
        hint={t('canvasEmptyHint')}
        action={emptyAction}
      />
    )

  return (
    <div className="space-y-4">
      {/* What the canvas is currently showing (the pickers are gone — the chips are how the member reads the
          lens back) + the one action that outlives the conversation. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {describeConfig(config, t).map((chip, i) => (
          <span
            key={i}
            className="rounded bg-secondary/60 px-1.5 py-0.5 text-[11px] font-[510] text-muted-foreground"
          >
            {chip}
          </span>
        ))}
        {canManage && (
          <SaveAnalysisButton
            config={config}
            activeView={activeView}
            currentSubject={currentSubject}
            isAdmin={isAdmin}
          />
        )}
      </div>

      <AnalysisBoard scorecards={scorecards} authors={authors} config={config} />
    </div>
  )
}

// The drawn lens itself — chart/table plus the drill-down into the records behind a clicked mark.
function AnalysisBoard({
  scorecards,
  authors,
  config,
}: {
  scorecards: ScorecardRecord[]
  authors: Record<string, Author>
  config: AnalysisConfig
}) {
  const t = useTranslations('analyzeScorecards')
  // Drill-down target: the group row / time bucket whose underlying records the raw table is scoped to. The
  // raw table is NOT part of the resting canvas — it appears only where the member asked "which runs are these?".
  const [focus, setFocus] = useState<Focus>()

  const resolveOwner = (s: string) => authors[s]?.name ?? (s ? fmtSubject(s) : '—')

  const result = useMemo(
    () => computeAnalysis(scorecards, config, resolveOwner, t('all')),
    [scorecards, config, authors, t]
  )

  // Re-shaping the analysis invalidates a drill-down key, so the focus goes with it.
  const shapeKey = `${config.groupBy.join(',')}:${config.viz}`
  useEffect(() => setFocus(undefined), [shapeKey])

  // The records the aggregate was computed from, scoped to the focused mark.
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

  return (
    <div className="space-y-4">
      {/* results — every mark is a drill-down handle into the records behind it */}
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

      {/* The chart's table twin — the records behind ONE clicked mark. Nothing is listed until the member
          drills in: the resting canvas is the lens the conversation drew, not a data dump under it. */}
      {focus && (
        <RawRowsTable
          rows={focusedRows}
          {...(config.metric ? { metric: config.metric } : {})}
          focusLabel={focus.label}
          onClearFocus={() => setFocus(undefined)}
        />
      )}
    </div>
  )
}
