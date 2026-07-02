import Link from 'next/link'
import { Plus } from 'lucide-react'

import { RunsTable } from '@/widgets/runs-table'
import { runsSchema } from '@/entities/run'
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
  try {
    runs = runsSchema.parse(await controlPlane.listRuns(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // 실행 중/대기 중인 run 이 있으면 라이브로 갱신(활동 콘솔) — 스코어카드 상세와 동일 패턴.
  const active = runs.some((r) => r.status === 'queued' || r.status === 'running')

  return (
    <div className="space-y-6">
      <AutoRefresh enabled={active} />
      <PageHeader
        title="실행 활동"
        description={`${runs.length}건 · 워크스페이스에서 실행 중/실행된 run (스코어카드 케이스 run 은 제외)`}
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
        <RunsTable runs={runs} workspace={workspace} />
      )}
    </div>
  )
}
