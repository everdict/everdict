'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'

import type { ScorecardRecord } from '@/entities/scorecard'
import { fmtScore, fmtSubject, HEALTH_TEXT, rateHealth } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Combobox } from '@/shared/ui/combobox'
import { EmptyState } from '@/shared/ui/empty-state'

import {
  computeAnalysis,
  DIMENSION_KEY,
  type AnalysisConfig,
  type GridResult,
  type LineResult,
} from '../model/analysis'

type Author = { name: string; avatarUrl?: string }

// Only 3 "questions" are exposed to the user — each question fixes the rest of the pivot settings internally.
export type QuestionId = 'trend' | 'models' | 'harnesses'
const QUESTIONS: { id: QuestionId; labelKey: string; descKey: string; pick: 'harness' | null }[] = [
  { id: 'trend', labelKey: 'trendLabel', descKey: 'trendDesc', pick: 'harness' },
  { id: 'models', labelKey: 'modelsLabel', descKey: 'modelsDesc', pick: 'harness' },
  { id: 'harnesses', labelKey: 'harnessesLabel', descKey: 'harnessesDesc', pick: null },
]

const TREND_DAYS = 20

function buildConfig(q: QuestionId, harness: string, nowIso: string): AnalysisConfig {
  const base: AnalysisConfig = {
    filters: {},
    groupBy: [],
    measure: 'passRate',
    sort: { by: 'label', dir: 'asc' },
    viz: 'table',
  }
  if (q === 'trend') {
    const from = new Date(new Date(nowIso).getTime() - TREND_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10)
    return {
      ...base,
      filters: { harness: harness ? [harness] : undefined, from },
      groupBy: ['day', 'dataset'],
      viz: 'line',
    }
  }
  if (q === 'models') {
    return {
      ...base,
      filters: { harness: harness ? [harness] : undefined },
      groupBy: ['model'],
      pivotBy: 'dataset',
    }
  }
  // harnesses — benchmark (rows) × harness (columns)
  return { ...base, groupBy: ['dataset'], pivotBy: 'harness' }
}

function scoreCell(value: number | undefined) {
  if (value === undefined) return <span className="text-faint">–</span>
  const health = rateHealth(value <= 1 ? value : null)
  return (
    <span className={cn('font-[560] tabular-nums', HEALTH_TEXT[health])}>
      {fmtScore(value, value)}
    </span>
  )
}

// Per-benchmark trend lines (one line per benchmark).
function LineChart({ result }: { result: LineResult }) {
  const t = useTranslations('analyzeScorecards')
  const ariaLabel = t('scoreTrend')
  const W = 720
  const H = 200
  const pad = { l: 8, r: 8, t: 12, b: 22 }
  const all = result.series.flatMap((s) => s.points).filter((v): v is number => v !== undefined)
  const max = Math.max(1, ...all)
  const min = Math.min(0, ...all)
  const span = max - min || 1
  const n = result.buckets.length
  const x = (i: number) =>
    pad.l + (n <= 1 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (n - 1))
  const y = (v: number) => pad.t + (1 - (v - min) / span) * (H - pad.t - pad.b)
  const COLORS = [
    'var(--color-primary)',
    'var(--color-success)',
    'var(--color-warning)',
    '#4ea7ff',
    '#eb5757',
    '#a78bfa',
  ]
  return (
    <div className="space-y-2 overflow-x-auto rounded-lg border bg-card p-4 shadow-raise">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-52 w-full min-w-[520px]"
        role="img"
        aria-label={ariaLabel}
      >
        {result.series.map((s, si) => {
          const pts = s.points
            .map((v, i) => (v === undefined ? null : `${x(i)},${y(v)}`))
            .filter(Boolean)
            .join(' ')
          return (
            <g key={s.label}>
              <polyline
                points={pts}
                fill="none"
                stroke={COLORS[si % COLORS.length]}
                strokeWidth={2}
                strokeLinejoin="round"
              />
              {s.points.map((v, i) =>
                v === undefined ? null : (
                  <circle key={i} cx={x(i)} cy={y(v)} r={2.5} fill={COLORS[si % COLORS.length]} />
                )
              )}
            </g>
          )
        })}
        {result.buckets.map((b, i) => (
          <text
            key={b}
            x={x(i)}
            y={H - 6}
            textAnchor="middle"
            className="fill-[var(--color-faint)] text-[9px]"
          >
            {b.slice(5)}
          </text>
        ))}
      </svg>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
        {result.series.map((s, si) => (
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

// Grid (table) — group rows + pivot columns + pass-rate cells.
function GridTable({ result, config }: { result: GridResult; config: AnalysisConfig }) {
  const t = useTranslations('analyzeScorecards')
  return (
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
              <th className="px-3 py-2 text-right font-[510]">{t('passRateHeader')}</th>
            )}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r) => (
            <tr key={r.key} className="border-b border-border/60 last:border-0 hover:bg-elevated">
              {r.labels.map((l, i) => (
                <td key={i} className="px-3 py-2 font-[510] text-foreground">
                  {l || '—'}
                </td>
              ))}
              {result.pivotKeys.length > 0 ? (
                r.cells.map((c) => (
                  <td key={c.key} className="px-3 py-2 text-right">
                    {scoreCell(c.value)}
                  </td>
                ))
              ) : (
                <td className="px-3 py-2 text-right">{scoreCell(r.value)}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Scorecard analysis — makes just 3 concrete questions (trend·model compare·harness compare) very easy.
export function ScorecardAnalyzer({
  scorecards,
  authors,
  nowIso,
  initialQuestion,
  initialHarness,
}: {
  scorecards: ScorecardRecord[]
  authors: Record<string, Author>
  nowIso: string
  initialQuestion: QuestionId
  initialHarness: string
}) {
  const t = useTranslations('analyzeScorecards')
  const harnesses = useMemo(
    () => [...new Set(scorecards.map((s) => s.harness.id))].sort(),
    [scorecards]
  )
  const [q, setQ] = useState<QuestionId>(initialQuestion)
  const [harness, setHarness] = useState<string>(initialHarness || harnesses[0] || '')

  useEffect(() => {
    const p = new URLSearchParams({ q })
    if (q !== 'harnesses' && harness) p.set('h', harness)
    window.history.replaceState(null, '', `?${p.toString()}`)
  }, [q, harness])

  const resolveOwner = (s: string) => authors[s]?.name ?? (s ? fmtSubject(s) : '—')
  const question = QUESTIONS.find((x) => x.id === q) ?? QUESTIONS[0]
  const config = buildConfig(q, harness, nowIso)
  const result = useMemo(
    () => computeAnalysis(scorecards, config, resolveOwner, t('all')),
    [scorecards, config, authors, t]
  )

  return (
    <div className="space-y-4">
      {/* question selection */}
      <div className="grid gap-2 sm:grid-cols-3">
        {QUESTIONS.map((x) => (
          <button
            key={x.id}
            type="button"
            onClick={() => setQ(x.id)}
            className={cn(
              'rounded-lg border p-3 text-left transition-colors',
              q === x.id
                ? 'border-primary/50 bg-primary/8 shadow-raise'
                : 'border-border bg-card hover:border-border-strong'
            )}
          >
            <div className="text-[14px] font-[560] text-foreground">{t(x.labelKey)}</div>
            <div className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
              {t(x.descKey)}
            </div>
          </button>
        ))}
      </div>

      {/* minimal input — harness selection (trend·model compare only) */}
      {question.pick === 'harness' && (
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-muted-foreground">{t('harness')}</span>
          <Combobox
            options={harnesses.map((h) => ({ value: h, label: h }))}
            value={harness}
            onChange={setHarness}
            placeholder={t('harnessPlaceholder')}
            className="w-[220px]"
            emptyText={t('harnessEmpty')}
          />
        </div>
      )}

      {/* results */}
      {result.total === 0 ? (
        <EmptyState
          title={t('emptyTitle')}
          hint={question.pick === 'harness' ? t('emptyHintNoHarness') : t('emptyHintNoData')}
        />
      ) : result.kind === 'line' ? (
        <LineChart result={result} />
      ) : (
        <GridTable result={result} config={config} />
      )}

      <p className="text-[11px] text-faint">
        {t('summary', { total: result.total })}
        {q === 'trend' ? t('trendSuffix', { days: TREND_DAYS }) : ''}
      </p>
    </div>
  )
}
