import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'

import { TrendPicker, type DatasetOption } from '@/features/trend-scorecards'
import { datasetsSchema } from '@/entities/dataset'
import { scorecardTrendSchema, type ScorecardTrend } from '@/entities/scorecard'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

export const dynamic = 'force-dynamic'

function fmtScore(p: ScorecardTrend['points'][number]): string {
  if (p.passRate !== null) return `${Math.round(p.passRate * 100)}%`
  if (p.mean !== null) return p.mean.toFixed(2)
  return '–'
}
function fmtDelta(n: number | null): string {
  if (n === null) return '–'
  const arrow = n > 0 ? '▲' : n < 0 ? '▼' : '–'
  return `${arrow} ${n > 0 ? '+' : ''}${n.toFixed(2)}`
}
function fmtTime(iso: string): string {
  return iso
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z')
    .slice(0, 16)
}

// 의존성 없는 인라인 SVG 스파크라인 — score 시계열(회귀 포인트는 빨강).
function Sparkline({ points }: { points: ScorecardTrend['points'] }) {
  const vals = points.map((p) => p.score).filter((v): v is number => v !== null)
  if (vals.length < 2) return null
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const range = max - min || 1
  const W = 720
  const H = 120
  const pad = 10
  const n = points.length
  const x = (i: number) => pad + (i * (W - 2 * pad)) / Math.max(1, n - 1)
  const y = (v: number) => H - pad - ((v - min) / range) * (H - 2 * pad)
  const line = points
    .map((p, i) => (p.score === null ? null : `${x(i).toFixed(1)},${y(p.score).toFixed(1)}`))
    .filter((s): s is string => s !== null)
    .join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-32 w-full" role="img" aria-label="score 추이">
      <polyline points={line} fill="none" stroke="var(--color-primary)" strokeWidth={2} />
      {points.map((p, i) =>
        p.score === null ? null : (
          <circle
            key={p.scorecardId}
            cx={x(i)}
            cy={y(p.score)}
            r={4}
            fill={p.regressed ? 'var(--color-destructive)' : 'var(--color-success)'}
          />
        )
      )}
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

  let options: DatasetOption[] = []
  try {
    options = datasetsSchema
      .parse(await controlPlane.listDatasets(ctx))
      .map((d) => ({ id: d.id, label: `${d.id} (${d.versions.length}v)` }))
  } catch {
    // 목록 실패해도 안내는 보여준다
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
          스코어카드
        </Link>
        <PageHeader
          title="추이 (기간 트렌드)"
          description="한 데이터셋의 스코어카드를 시간순으로 — baseline 대비 회귀를 추적."
        />
      </div>

      {options.length === 0 ? (
        <EmptyState
          title="데이터셋이 없습니다."
          hint="벤치마크/데이터셋을 등록하고 같은 데이터셋을 여러 번 평가하면 추이가 쌓입니다."
        />
      ) : (
        <Card className="p-4">
          <TrendPicker datasets={options} dataset={dataset} metric={metric} baseline={baseline} />
        </Card>
      )}

      {error && <Callout tone="danger">추이 조회 실패: {error}</Callout>}

      {trend && (
        <div className="space-y-7">
          <Card className="space-y-4 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground">
                <code className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
                  {trend.dataset}
                </code>
                · metric
                <code className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
                  {trend.metric}
                </code>
                · baseline
                <code className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
                  {trend.baseline}
                </code>
              </p>
              <Badge tone={regressions.length > 0 ? 'danger' : 'success'}>
                {regressions.length > 0 ? `회귀 ${regressions.length}건` : '회귀 없음'}
              </Badge>
            </div>
            {trend.points.length < 2 ? (
              <p className="text-[13px] text-muted-foreground">
                추이를 그리려면 같은 데이터셋의 완료 스코어카드가 2건 이상 필요합니다(현재{' '}
                {trend.points.length}건).
              </p>
            ) : (
              <Sparkline points={trend.points} />
            )}
          </Card>

          {trend.points.length > 0 && (
            <section className="space-y-2.5">
              <SectionHeader title="실행 이력" />
              <Table>
                <THead>
                  <tr>
                    <TH>시각</TH>
                    <TH>harness</TH>
                    <TH className="text-right">{trend.metric}</TH>
                    <TH className="text-right">Δ vs baseline</TH>
                    <TH className="text-right">상태</TH>
                  </tr>
                </THead>
                <TBody>
                  {trend.points.map((p) => (
                    <TR key={p.scorecardId}>
                      <TD className="whitespace-nowrap font-mono text-[12px] text-muted-foreground">
                        {fmtTime(p.createdAt)}
                      </TD>
                      <TD>
                        <Link
                          href={`/${workspace}/scorecards/${p.scorecardId}`}
                          className="font-[510] text-link transition-colors hover:text-foreground"
                        >
                          {p.harness}
                        </Link>
                      </TD>
                      <TD className="text-right font-mono text-[12px] tabular-nums">
                        {fmtScore(p)}
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
                          <Badge tone="danger">회귀</Badge>
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
