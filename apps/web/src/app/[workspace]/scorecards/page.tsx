import Link from 'next/link'

import { scorecardsSchema } from '@/entities/scorecard'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { StatusPill } from '@/shared/ui/status-pill'

export const dynamic = 'force-dynamic'

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

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

  return (
    <div className="space-y-6">
      <PageHeader
        title="스코어카드"
        description={`${scorecards.length}건 · 데이터셋×하니스 배치 평가 결과`}
        actions={
          <div className="flex gap-2">
            <Link
              href={`/${workspace}/scorecards/leaderboard`}
              className={buttonVariants({ size: 'sm', variant: 'secondary' })}
            >
              리더보드
            </Link>
            <Link
              href={`/${workspace}/scorecards/by-harness`}
              className={buttonVariants({ size: 'sm', variant: 'secondary' })}
            >
              하니스별
            </Link>
            <Link
              href={`/${workspace}/scorecards/trend`}
              className={buttonVariants({ size: 'sm', variant: 'secondary' })}
            >
              추이
            </Link>
            <Link
              href={`/${workspace}/scorecards/compare`}
              className={buttonVariants({ size: 'sm', variant: 'secondary' })}
            >
              비교
            </Link>
            {can(principal?.roles, 'scorecards:run') ? (
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
      ) : scorecards.length === 0 ? (
        <EmptyState
          title="스코어카드가 없습니다."
          hint="member 이상이면 '스코어카드 실행'으로 데이터셋을 하니스에 돌리거나, API/MCP(run_scorecard)로 실행하세요."
        />
      ) : (
        <div className="space-y-2">
          {scorecards.map((s) => (
            <Link
              key={s.id}
              href={`/${workspace}/scorecards/${encodeURIComponent(s.id)}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
            >
              <div className="min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-x-1 font-mono text-[13px] font-[510]">
                  {s.dataset.id}
                  <span className="text-faint">@{s.dataset.version}</span>
                  <span className="px-1 text-muted-foreground">→</span>
                  {s.harness.id}
                  <span className="text-faint">@{s.harness.version}</span>
                  {s.models?.primary ? (
                    <span className="ml-1 rounded border border-border bg-secondary px-1.5 py-0.5 text-[11px] text-secondary-foreground">
                      {s.models.primary}
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-1">
                  {(s.summary ?? []).map((m) => (
                    <code
                      key={m.metric}
                      className="rounded border border-border bg-secondary px-1.5 py-0.5 font-mono text-[11px] text-secondary-foreground"
                    >
                      <span className="text-faint">{m.metric}</span> {m.mean.toFixed(2)}
                      {m.passRate != null ? ` · ${pct(m.passRate)}` : ''}
                    </code>
                  ))}
                </div>
              </div>
              <StatusPill status={s.status} />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
