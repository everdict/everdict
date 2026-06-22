import Link from 'next/link'

import { RunsTable } from '@/widgets/runs-table'
import { runsSchema } from '@/entities/run'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function RunsPage() {
  const { principal, ctx } = await currentPrincipal()
  let error: string | undefined
  let runs = runsSchema.parse([])
  try {
    runs = runsSchema.parse(await controlPlane.listRuns(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Runs"
        description={`${runs.length}건 · workspace ${principal?.workspace ?? '—'}`}
        actions={
          can(principal?.roles, 'runs:submit') ? (
            <Link href="/dashboard/runs/new" className={buttonVariants({ size: 'sm' })}>
              새 run
            </Link>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">컨트롤플레인 연결 실패: {error}</Callout>
      ) : (
        <RunsTable runs={runs} />
      )}
    </div>
  )
}
