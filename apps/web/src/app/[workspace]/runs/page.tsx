import Link from 'next/link'
import { Plus } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

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
  const t = await getTranslations('runsPage')
  const { principal, ctx } = await currentPrincipal()
  let error: string | undefined
  let runs = runsSchema.parse([])
  try {
    // Runs list — individual executions in this workspace. Scorecard child runs are excluded by the control plane;
    // batch evals live on their own /scorecards page, so this stays runs-only.
    runs = await controlPlane.listRuns(ctx).then((r) => runsSchema.parse(r))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // If any run is still queued/running, refresh live (activity console).
  const active = runs.some((x) => x.status === 'queued' || x.status === 'running')

  return (
    <div className="space-y-6">
      <AutoRefresh enabled={active} />
      <PageHeader
        title={t('title')}
        description={t('description', { runs: runs.length })}
        actions={
          can(principal?.roles, 'runs:submit') ? (
            <Link href={`/${workspace}/runs/new`} className={buttonVariants({ size: 'sm' })}>
              <Plus className="size-4" />
              {t('newRun')}
            </Link>
          ) : null
        }
      />
      {error ? (
        <Callout tone="danger">{t('connectError', { error })}</Callout>
      ) : (
        <RunsTable runs={runs} workspace={workspace} />
      )}
    </div>
  )
}
