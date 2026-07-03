import Link from 'next/link'

import { scorecardsSchema } from '@/entities/scorecard'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EntityRef, MetricChip, ModelChip } from '@/shared/ui/chip'
import { EmptyState } from '@/shared/ui/empty-state'
import { OriginChip } from '@/shared/ui/origin'
import { PageHeader } from '@/shared/ui/page-header'
import { StatCard } from '@/shared/ui/stat-card'
import { StatusPill } from '@/shared/ui/status-pill'

export const dynamic = 'force-dynamic'

// 분석 뷰(집계) — 스코어카드는 개별 실행, 아래 4뷰는 이들을 가로질러 보는 렌즈.
const ANALYTICS_VIEWS = [
  { seg: 'leaderboard', label: '리더보드' },
  { seg: 'by-harness', label: '하니스별' },
  { seg: 'trend', label: '추이' },
  { seg: 'compare', label: '비교' },
] as const

export default async function ScorecardsPage({
  params,
}: {
  params: Promise<{ workspace: string }>
}) {
  const { workspace } = await params
  const { principal, ctx } = await currentPrincipal()
  let error: string | undefined
  let scorecards = scorecardsSchema.parse([])
  try {
    scorecards = scorecardsSchema.parse(await controlPlane.listScorecards(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const total = scorecards.length
  const succeeded = scorecards.filter((s) => s.status === 'succeeded').length
  const running = scorecards.filter((s) => s.status === 'running' || s.status === 'queued').length
  const failed = scorecards.filter((s) => s.status === 'failed').length
  const canRun = can(principal?.roles, 'scorecards:run')

  return (
    <div className="space-y-6">
      <PageHeader
        title="스코어카드"
        description="데이터셋 × 하니스 배치 평가 — 케이스별 채점을 메트릭으로 집계."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* 분석 렌즈 묶음 — 개별 실행과 시각적으로 구분(세그먼트) */}
            <div className="inline-flex overflow-hidden rounded-lg border bg-card shadow-raise">
              {ANALYTICS_VIEWS.map((v, i) => (
                <Link
                  key={v.seg}
                  href={`/${workspace}/scorecards/${v.seg}`}
                  className={cn(
                    'px-3 py-1.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:bg-elevated hover:text-foreground',
                    i > 0 && 'border-l'
                  )}
                >
                  {v.label}
                </Link>
              ))}
            </div>
            {canRun ? (
              <>
                <Link
                  href={`/${workspace}/scorecards/ingest`}
                  className={buttonVariants({ size: 'sm', variant: 'secondary' })}
                >
                  인제스트
                </Link>
                <Link
                  href={`/${workspace}/scorecards/new`}
                  className={buttonVariants({ size: 'sm' })}
                >
                  스코어카드 실행
                </Link>
              </>
            ) : null}
          </div>
        }
      />

      {error ? (
        <Callout tone="danger">컨트롤플레인 연결 실패: {error}</Callout>
      ) : total === 0 ? (
        <EmptyState
          title="스코어카드가 없습니다."
          hint="member 이상이면 '스코어카드 실행'으로 데이터셋을 하니스에 돌리거나, API/MCP(run_scorecard)로 실행하세요."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="전체" value={total} />
            <StatCard label="성공" value={succeeded} tone={succeeded > 0 ? 'success' : 'default'} />
            <StatCard label="진행중" value={running} tone={running > 0 ? 'primary' : 'default'} />
            <StatCard label="실패" value={failed} tone={failed > 0 ? 'danger' : 'default'} />
          </div>

          <div className="space-y-2">
            {scorecards.map((s, i) => (
              <Link
                key={s.id}
                href={`/${workspace}/scorecards/${encodeURIComponent(s.id)}`}
                style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}
                className="rise grid grid-cols-[1fr_auto] items-center gap-3 rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] font-[510]">
                    <EntityRef id={s.dataset.id} version={s.dataset.version} />
                    <span className="text-faint">→</span>
                    <EntityRef id={s.harness.id} version={s.harness.version} />
                    {s.models?.primary ? <ModelChip>{s.models.primary}</ModelChip> : null}
                    {s.origin ? <OriginChip origin={s.origin} /> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    {(s.summary ?? []).length > 0 ? (
                      (s.summary ?? []).map((m) => (
                        <MetricChip
                          key={m.metric}
                          metric={m.metric}
                          mean={m.mean}
                          passRate={m.passRate}
                        />
                      ))
                    ) : (
                      <span className="text-[11px] text-faint">
                        {s.status === 'failed' ? '집계 없음' : '집계 대기'}
                      </span>
                    )}
                    {s.judgeModels && s.judgeModels.length > 0 ? (
                      <span className="ml-1 inline-flex items-center gap-1">
                        <span className="text-[10px] uppercase tracking-wide text-faint">
                          judge
                        </span>
                        {s.judgeModels.map((jm) => (
                          <ModelChip key={jm} muted>
                            {jm}
                          </ModelChip>
                        ))}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StatusPill status={s.status} />
                  <time
                    className="font-mono text-[11px] text-muted-foreground"
                    title={fmtDateTimeFull(s.createdAt)}
                  >
                    {fmtDateTime(s.createdAt)}
                  </time>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
