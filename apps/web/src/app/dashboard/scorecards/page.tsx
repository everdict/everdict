import Link from 'next/link'

import { scorecardsSchema } from '@/entities/scorecard'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { buttonVariants } from '@/shared/ui/button'
import { Card, CardContent } from '@/shared/ui/card'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { StatusPill } from '@/shared/ui/status-pill'

export const dynamic = 'force-dynamic'

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

export default async function ScorecardsPage() {
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
            <Link href="/dashboard/scorecards/compare" className={buttonVariants({ size: 'sm', variant: 'secondary' })}>
              비교
            </Link>
            {can(principal?.roles, 'scorecards:run') ? (
              <Link href="/dashboard/scorecards/new" className={buttonVariants({ size: 'sm' })}>
                스코어카드 실행
              </Link>
            ) : null}
          </div>
        }
      />
      {error ? (
        <Card className="border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
          컨트롤플레인 연결 실패: {error}
        </Card>
      ) : scorecards.length === 0 ? (
        <EmptyState
          title="스코어카드가 없습니다."
          hint="member 이상이면 '스코어카드 실행'으로 데이터셋을 하니스에 돌리거나, API/MCP(run_scorecard)로 실행하세요."
        />
      ) : (
        <div className="space-y-3">
          {scorecards.map((s) => (
            <Link key={s.id} href={`/dashboard/scorecards/${encodeURIComponent(s.id)}`}>
              <Card className="transition-colors hover:border-primary/40">
                <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-5">
                  <div className="space-y-1">
                    <div className="font-mono text-sm font-medium">
                      {s.dataset.id}
                      <span className="text-muted-foreground">@{s.dataset.version}</span>
                      <span className="px-2 text-muted-foreground">→</span>
                      {s.harness.id}
                      <span className="text-muted-foreground">@{s.harness.version}</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {(s.summary ?? []).map((m) => (
                        <code key={m.metric} className="rounded-md bg-secondary px-1.5 py-0.5 text-xs">
                          {m.metric} {m.mean.toFixed(2)}
                          {m.passRate != null ? ` · ${pct(m.passRate)}` : ''}
                        </code>
                      ))}
                    </div>
                  </div>
                  <StatusPill status={s.status} />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
