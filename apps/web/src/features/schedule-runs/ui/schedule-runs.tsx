'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'

import type { ScorecardStatus } from '@/entities/scorecard'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { UserAvatar } from '@/shared/ui/avatar'
import { MetricChip } from '@/shared/ui/chip'
import { Link } from '@/shared/ui/link'
import { StatusIcon } from '@/shared/ui/status-pill'

// How many to show per page — it stops a bulk render and reveals progressively through "show more" (the same as the judge history).
const PAGE_SIZE = 10

// The minimum data one run-history row needs — assembled on the server and passed down (a serializable flat shape).
export interface ScheduleRunEntry {
  id: string
  traceEval: boolean // is it trace evaluation mode (no dataset/harness)
  // mean is ABSENT for a zero-measurement metric (every score unmeasured) — the chip renders the unmeasured
  // marker; dropping the field here is what turned dead graders into 0.00 rows.
  metrics: { metric: string; mean?: number; passRate?: number | null; unmeasured?: number }[]
  createdAt: string
  status: ScorecardStatus
  runner?: { name: string; avatarUrl?: string }
}

// Take the "primary metric" of the scorecards this schedule produced, in time order, to make a trend.
// The primary metric = the metric appearing most often across the completed runs (ties go to whichever came first). With fewer than two data points no trend is drawn.
function primaryTrend(
  entries: ScheduleRunEntry[]
): { metric: string; points: { at: string; value: number }[] } | null {
  const counts = new Map<string, number>()
  for (const e of entries)
    for (const m of e.metrics) counts.set(m.metric, (counts.get(m.metric) ?? 0) + 1)
  if (counts.size === 0) return null
  let metric = ''
  let best = -1
  for (const [name, n] of counts) {
    if (n > best) {
      best = n
      metric = name
    }
  }
  // Oldest → newest (the input is newest first). Only runs where that metric was MEASURED — drawing a point with no mean (everything
  // unmeasured) as 0 disguises a grader outage as a collapsing trend.
  const points = [...entries]
    .reverse()
    .map((e) => {
      const m = e.metrics.find((x) => x.metric === metric)
      return m && m.mean !== undefined ? { at: e.createdAt, value: m.mean } : null
    })
    .filter((p): p is { at: string; value: number } => p !== null)
  return points.length >= 2 ? { metric, points } : null
}

// The trend sparkline — the primary metric's mean as a line in time order. It assumes nothing about whether a value is good or bad (neutral).
function RunTrend({ entries }: { entries: ScheduleRunEntry[] }) {
  const t = useTranslations('scheduleDetail')
  const trend = useMemo(() => primaryTrend(entries), [entries])
  if (!trend) return null

  const values = trend.points.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  const n = trend.points.length
  const coords = trend.points.map((p, i) => {
    const x = n === 1 ? 50 : (i / (n - 1)) * 100
    const y = span === 0 ? 50 : 100 - ((p.value - min) / span) * 100
    return { x, y }
  })
  const line = coords.map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`).join(' ')
  const first = values[0] ?? 0
  const last = values[values.length - 1] ?? 0
  const delta = last - first

  return (
    <div className="rounded-lg border bg-card/60 p-3.5 shadow-raise">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span
          className="truncate font-mono text-[11.5px] text-muted-foreground"
          title={trend.metric}
        >
          {t('trendLabel', { metric: trend.metric })}
        </span>
        <span className="shrink-0 tabular-nums text-[12px]">
          <span className="font-[560] text-foreground">{last.toFixed(2)}</span>
          {delta !== 0 && (
            <span className="ml-1.5 text-[11px] text-faint">
              {delta > 0 ? '+' : ''}
              {delta.toFixed(2)}
            </span>
          )}
        </span>
      </div>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-14 w-full text-[var(--color-primary)]"
        role="img"
        aria-label={t('trendLabel', { metric: trend.metric })}
      >
        <polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {coords.map((c, i) => (
          <circle
            key={`${c.x}-${i}`}
            cx={c.x}
            cy={c.y}
            r={1.6}
            fill="currentColor"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    </div>
  )
}

// A schedule detail's run history — the scorecards this schedule produced (newest first), with the primary metric's trend sparkline on top.
// A row: status · the primary metric chip · (a trace-evaluation tag) · who ran it · the time → linking to the scorecard detail.
export function ScheduleRuns({
  workspace,
  entries,
  timeZone,
}: {
  workspace: string
  entries: ScheduleRunEntry[]
  timeZone: string
}) {
  const t = useTranslations('scheduleDetail')
  const [visible, setVisible] = useState(PAGE_SIZE)
  const shown = entries.slice(0, visible)
  const remaining = entries.length - shown.length

  return (
    <div className="space-y-3">
      <RunTrend entries={entries} />
      {/* Rows divided by separators inside ONE card — the same grammar as the capability detail's "issues watching this capability" list.
          Floating a card per row makes it read as a pile of cards rather than a list. */}
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {shown.map((s) => {
          const siblings = s.metrics.map((m) => m.metric)
          return (
            <Link
              key={s.id}
              href={`/${workspace}/scorecard/${encodeURIComponent(s.id)}`}
              className="flex items-center gap-3 px-3.5 py-2.5 text-[13px] transition-colors hover:bg-elevated"
            >
              <span className="flex w-5 shrink-0 justify-center">
                <StatusIcon status={s.status} />
              </span>
              {/* The primary metric chip — a schedule has a fixed subject (dataset, harness), so the METRIC is the row's main information. */}
              <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
                {s.traceEval && (
                  <span className="mr-1 shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10.5px] font-[510] text-muted-foreground">
                    {t('traceEvalTag')}
                  </span>
                )}
                {s.metrics.slice(0, 3).map((m) => (
                  <span key={m.metric} className="shrink-0">
                    <MetricChip
                      metric={m.metric}
                      mean={m.mean}
                      passRate={m.passRate}
                      unmeasured={m.unmeasured}
                      siblings={siblings}
                    />
                  </span>
                ))}
                {s.metrics.length > 3 && (
                  <span className="shrink-0 text-[11px] text-faint">+{s.metrics.length - 3}</span>
                )}
                {s.metrics.length === 0 && (
                  <span className="truncate text-[12px] text-faint">{t('runNoMetrics')}</span>
                )}
              </div>
              {/* Who ran it · when — fixed width */}
              <div className="flex shrink-0 items-center gap-2.5">
                <span className="flex w-6 justify-center">
                  {s.runner && (
                    <UserAvatar
                      name={s.runner.name}
                      url={s.runner.avatarUrl}
                      label={t('runRunner')}
                    />
                  )}
                </span>
                <time
                  className="hidden w-[84px] text-right font-mono text-[11px] text-muted-foreground sm:block"
                  title={fmtDateTimeFull(s.createdAt, { timeZone })}
                >
                  {fmtDateTime(s.createdAt, timeZone)}
                </time>
              </div>
            </Link>
          )
        })}
        {remaining > 0 && (
          <button
            type="button"
            onClick={() => setVisible((v) => v + PAGE_SIZE)}
            className="w-full px-3.5 py-2 text-[12px] font-[510] text-muted-foreground transition-colors hover:bg-elevated hover:text-foreground"
          >
            {t('runsLoadMore', { count: remaining })}
          </button>
        )}
      </div>
    </div>
  )
}
