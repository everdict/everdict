import Link from 'next/link'
import { Plus } from 'lucide-react'

import { ActivityFeed } from '@/widgets/activity-feed'
import { runsSchema } from '@/entities/run'
import { scorecardsSchema } from '@/entities/scorecard'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { AutoRefresh } from '@/shared/ui/auto-refresh'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function RunsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const { principal, ctx } = await currentPrincipal()
  let error: string | undefined
  let runs = runsSchema.parse([])
  let scorecards = scorecardsSchema.parse([])
  try {
    // 통합 활동 피드: standalone run + 스코어카드 배치를 한 타임라인으로. 둘 다 워크스페이스 스코프.
    ;[runs, scorecards] = await Promise.all([
      controlPlane.listRuns(ctx).then((r) => runsSchema.parse(r)),
      controlPlane.listScorecards(ctx).then((s) => scorecardsSchema.parse(s)),
    ])
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // 실행 중/대기 중인 run 이나 스코어카드가 있으면 라이브로 갱신(활동 콘솔).
  const active = [...runs, ...scorecards].some(
    (x) => x.status === 'queued' || x.status === 'running'
  )

  return (
    <div className="space-y-6">
      <AutoRefresh enabled={active} />
      <PageHeader
        title="활동"
        description={`run ${runs.length}건 · 스코어카드 ${scorecards.length}건 · 실행 중/실행된 것들 (스코어카드 케이스 run 은 제외)`}
        actions={
          can(principal?.roles, 'runs:submit') ? (
            <Link href={`/${workspace}/runs/new`} className={buttonVariants({ size: 'sm' })}>
              <Plus className="size-4" />새 Run
            </Link>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">컨트롤플레인 연결 실패: {error}</Callout>
      ) : (
        <ActivityFeed runs={runs} scorecards={scorecards} workspace={workspace} />
      )}
    </div>
  )
}
