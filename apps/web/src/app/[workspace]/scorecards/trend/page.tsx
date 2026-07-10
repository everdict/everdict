import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { getTranslations } from 'next-intl/server'

import { TrendPicker, type DatasetOption } from '@/features/trend-scorecards'
import { datasetsSchema } from '@/entities/dataset'
import { scorecardTrendSchema, type ScorecardTrend } from '@/entities/scorecard'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtDateTime, fmtDateTimeFull, fmtMetricLabel, fmtScore } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EntityRef } from '@/shared/ui/chip'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { Score } from '@/shared/ui/score'
import { SectionHeader } from '@/shared/ui/section-header'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

export const dynamic = 'force-dynamic'

function fmtDelta(n: number | null): string {
  if (n === null) return '–'
  const arrow = n > 0 ? '▲' : n < 0 ? '▼' : '–'
  return `${arrow} ${n > 0 ? '+' : ''}${n.toFixed(2)}`
}

// Dependency-free inline SVG sparkline — score time series + baseline reference line + point hover tooltip (regressions in red).
function Sparkline({ points }: { points: ScorecardTrend['points'] }) {
  const t = useTranslations('scorecardsPage')
  const pts = points
    .map((p, i) => ({ ...p, i }))
    .filter((p): p is (typeof points)[number] & { score: number; i: number } => p.score !== null)
  if (pts.length < 2) return null

  // baseline score = score − deltaVsBaseline (back-computed from the first point with a delta). Drawn as the reference line.
  const ref = points.find((p) => p.score !== null && p.deltaVsBaseline !== null)
  const baseScore =
    ref && ref.score !== null && ref.deltaVsBaseline !== null
      ? ref.score - ref.deltaVsBaseline
      : null

  const vals = pts.map((p) => p.score)
  if (baseScore !== null) vals.push(baseScore)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const range = max - min || 1
  const W = 720
  const H = 140
  const padX = 12
  const padY = 18
  const n = points.length
  const x = (i: number) => padX + (i * (W - 2 * padX)) / Math.max(1, n - 1)
  const y = (v: number) => H - padY - ((v - min) / range) * (H - 2 * padY)

  const line = pts.map((p) => `${x(p.i).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ')
  const area = `${x(pts[0].i).toFixed(1)},${(H - padY).toFixed(1)} ${line} ${x(pts[pts.length - 1].i).toFixed(1)},${(H - padY).toFixed(1)}`
  const last = pts[pts.length - 1]

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-36 w-full"
      role="img"
      aria-label={t('sparklineLabel')}
    >
      <defs>
        <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {baseScore !== null && (
        <>
          <line
            x1={padX}
            x2={W - padX}
            y1={y(baseScore)}
            y2={y(baseScore)}
            stroke="var(--color-muted-foreground)"
            strokeWidth={1}
            strokeDasharray="3 3"
            opacity={0.5}
          />
          <text
            x={W - padX}
            y={y(baseScore) - 4}
            textAnchor="end"
            className="fill-[var(--color-muted-foreground)] text-[10px]"
          >
            baseline {baseScore.toFixed(2)}
          </text>
        </>
      )}
      <polygon points={area} fill="url(#trend-fill)" />
      <polyline points={line} fill="none" stroke="var(--color-primary)" strokeWidth={2} />
      {pts.map((p) => (
        <circle
          key={p.scorecardId}
          cx={x(p.i)}
          cy={y(p.score)}
          r={4}
          fill={p.regressed ? 'var(--color-destructive)' : 'var(--color-success)'}
        >
          <title>{`${fmtDateTime(p.createdAt)} · ${fmtScore(p.passRate, p.mean)}${p.regressed ? ` · ${t('regressed')}` : ''}`}</title>
        </circle>
      ))}
      <text
        x={Math.min(x(last.i) + 8, W - 4)}
        y={y(last.score) - 6}
        textAnchor={last.i === n - 1 ? 'end' : 'start'}
        className="fill-foreground text-[11px] font-[560]"
      >
        {fmtScore(last.passRate, last.mean)}
      </text>
    </svg>
  )
}

export default async function TrendPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ dataset?: string; metric?: string; baseline?: string }>
}) {
  const { workspace } = await params
  const { dataset, metric, baseline } = await searchParams
  const ctx = await authContext()
  const t = await getTranslations('scorecardsPage')

  let options: DatasetOption[] = []
  try {
    options = datasetsSchema
      .parse(await controlPlane.listDatasets(ctx))
      .map((d) => ({ id: d.id, label: `${d.id} (${d.versions.length}v)` }))
  } catch {
    // Even if the list fails, still show guidance
  }

  let trend: ScorecardTrend | undefined
  let error: string | undefined
  if (dataset) {
    try {
      trend = scorecardTrendSchema.parse(
        await controlPlane.trendScorecards(ctx, {
          dataset,
          metric: metric ?? 'judge',
          baseline: baseline ?? 'first',
        })
      )
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  const regressions = trend?.points.filter((p) => p.regressed) ?? []

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <Link
          href={`/${workspace}/scorecards`}
          className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {t('backToList')}
        </Link>
        <PageHeader title={t('trendTitle')} description={t('trendDescription')} />
      </div>

      {options.length === 0 ? (
        <EmptyState title={t('noDatasetsTitle')} hint={t('trendEmptyHint')} />
      ) : (
        <Card className="p-4">
          <TrendPicker datasets={options} dataset={dataset} metric={metric} baseline={baseline} />
        </Card>
      )}

      {error && <Callout tone="danger">{t('trendLoadError', { error })}</Callout>}

      {trend && (
        <div className="space-y-7">
          <Card className="space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
                <code className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
                  {trend.dataset}
                </code>
                · metric
                <code
                  title={trend.metric}
                  className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]"
                >
                  {fmtMetricLabel(trend.metric)}
                </code>
                · baseline
                <code className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
                  {trend.baseline}
                </code>
              </p>
              <Badge tone={regressions.length > 0 ? 'danger' : 'success'}>
                {regressions.length > 0
                  ? t('regressedCount', { count: regressions.length })
                  : t('noRegression')}
              </Badge>
            </div>
            {trend.points.length < 2 ? (
              <p className="text-[13px] text-muted-foreground">
                {t('needTwoPoints', { count: trend.points.length })}
              </p>
            ) : (
              <Sparkline points={trend.points} />
            )}
          </Card>

          {trend.points.length > 0 && (
            <section className="space-y-2.5">
              <SectionHeader title={t('runHistoryTitle')} />
              <Table>
                <THead>
                  <tr>
                    <TH>{t('thTime')}</TH>
                    <TH>harness</TH>
                    <TH className="text-right" title={trend.metric}>
                      {fmtMetricLabel(trend.metric)}
                    </TH>
                    <TH className="text-right">Δ vs baseline</TH>
                    <TH className="text-right">{t('thStatus')}</TH>
                  </tr>
                </THead>
                <TBody>
                  {trend.points.map((p) => (
                    <TR key={p.scorecardId}>
                      <TD
                        className="whitespace-nowrap font-mono text-[11px] text-muted-foreground"
                        title={fmtDateTimeFull(p.createdAt)}
                      >
                        {fmtDateTime(p.createdAt)}
                      </TD>
                      <TD>
                        <Link
                          href={`/${workspace}/scorecards/${p.scorecardId}`}
                          className="font-[510] text-link transition-colors hover:text-foreground"
                        >
                          <EntityRef id={p.harness} kind="harness" />
                        </Link>
                      </TD>
                      <TD className="text-right">
                        <Score passRate={p.passRate} mean={p.mean} />
                      </TD>
                      <TD
                        className={`text-right font-mono text-[12px] tabular-nums ${
                          p.deltaVsBaseline === null || p.deltaVsBaseline === 0
                            ? 'text-muted-foreground'
                            : p.deltaVsBaseline > 0
                              ? 'font-[510] text-[var(--color-success)]'
                              : 'font-[510] text-destructive'
                        }`}
                      >
                        {fmtDelta(p.deltaVsBaseline)}
                      </TD>
                      <TD className="text-right">
                        {p.regressed ? (
                          <Badge tone="danger">{t('regressed')}</Badge>
                        ) : (
                          <span className="text-faint">–</span>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
