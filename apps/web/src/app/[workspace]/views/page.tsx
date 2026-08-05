import { getTranslations } from 'next-intl/server'

import { loadAnalysisData, ViewList } from '@/features/analyze-scorecards'
import { authContext } from '@/shared/auth/principal'
import { agentPlane } from '@/shared/lib/agent-plane'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Saved analysis views — first-class objects. List/manage + open (live re-run). Creation happens in the studio canvas (+ agent chat).
export default async function ViewsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('viewsPage')
  const { savedViews, authors, subject, isAdmin, error } = await loadAnalysisData()
  // Per-view artifact rollup (agent service, best-effort) — the cards show "N artifacts · last report …".
  let artifactSummary: Record<string, { count: number; lastReportAt?: string }> | undefined
  if (savedViews.length > 0) {
    try {
      const ctx = await authContext()
      artifactSummary = (
        (await agentPlane.viewArtifactsSummary(
          ctx,
          savedViews.map((v) => v.id)
        )) as { summary: Record<string, { count: number; lastReportAt?: string }> }
      ).summary
    } catch {
      // silent — the list renders without artifact chips
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Link
            href={`/${workspace}/scorecards/analyze?chat=1`}
            className={buttonVariants({ size: 'sm' })}
          >
            {t('newAnalysis')}
          </Link>
        }
      />
      {error ? (
        <Callout tone="danger">{t('connectError', { error })}</Callout>
      ) : savedViews.length === 0 ? (
        <EmptyState
          title={t('emptyTitle')}
          hint={t('emptyHint')}
          action={
            <Link
              href={`/${workspace}/scorecards/analyze?chat=1`}
              className={buttonVariants({ size: 'sm' })}
            >
              {t('createAnalysis')}
            </Link>
          }
        />
      ) : (
        <ViewList
          views={savedViews}
          authors={authors}
          currentSubject={subject}
          isAdmin={isAdmin}
          workspace={workspace}
          artifactSummary={artifactSummary}
        />
      )}
    </div>
  )
}
