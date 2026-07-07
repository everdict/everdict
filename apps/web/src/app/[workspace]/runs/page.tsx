import Link from 'next/link'
import { Plus } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

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
  const t = await getTranslations('runsPage')
  const { principal, ctx } = await currentPrincipal()
  let error: string | undefined
  let runs = runsSchema.parse([])
  let scorecards = scorecardsSchema.parse([])
  try {
    // Unified activity feed: standalone runs + scorecard batches on one timeline. Both are workspace-scoped.
    ;[runs, scorecards] = await Promise.all([
      controlPlane.listRuns(ctx).then((r) => runsSchema.parse(r)),
      controlPlane.listScorecards(ctx).then((s) => scorecardsSchema.parse(s)),
    ])
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // If there are running/pending runs or scorecards, refresh live (activity console).
  const active = [...runs, ...scorecards].some(
    (x) => x.status === 'queued' || x.status === 'running'
  )

  return (
    <div className="space-y-6">
      <AutoRefresh enabled={active} />
      <PageHeader
        title={t('title')}
        description={t('description', { runs: runs.length, scorecards: scorecards.length })}
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
        <ActivityFeed runs={runs} scorecards={scorecards} workspace={workspace} />
      )}
    </div>
  )
}
