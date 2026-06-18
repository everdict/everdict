import { runsSchema } from '@/entities/run'
import { RunsTable } from '@/widgets/runs-table'
import { currentTenant } from '@/shared/auth/tenant'
import { controlPlane } from '@/shared/lib/control-plane'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

export default async function RunsPage() {
  const { tenant } = await currentTenant()
  let error: string | undefined
  let runs = runsSchema.parse([])
  try {
    runs = runsSchema.parse(await controlPlane.listRuns(tenant))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Runs" description={`${runs.length}건 · tenant ${tenant}`} />
      {error ? (
        <Card className="border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
          컨트롤플레인 연결 실패: {error}
        </Card>
      ) : (
        <RunsTable runs={runs} />
      )}
    </div>
  )
}
