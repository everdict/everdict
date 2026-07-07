import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { CustomAnalyzer, loadAnalysisData, storedToConfig } from '@/features/analyze-scorecards'
import { CommentsSection } from '@/features/discuss'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Open a saved view — a first-class URL (/{ws}/views/{id}). Fills the dashboard from config and re-runs on current data (live).
// Someone else's private/nonexistent view isn't in the list (listVisible), so notFound (404) — don't leak existence.
export default async function ViewPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('viewsPage')
  const { scorecards, authors, savedViews, subject, canManage, isAdmin, error } =
    await loadAnalysisData()
  const view = savedViews.find((v) => v.id === id)
  if (!view) notFound()

  return (
    <div className="space-y-6">
      <PageHeader
        title={view.name}
        description={
          view.visibility === 'workspace'
            ? t('detailDescriptionWorkspace')
            : t('detailDescriptionPrivate')
        }
        actions={
          <Link
            href={`/${workspace}/views`}
            className={buttonVariants({ size: 'sm', variant: 'secondary' })}
          >
            <ArrowLeft className="size-4" /> {t('backToList')}
          </Link>
        }
      />
      {error ? (
        <Callout tone="danger">{t('connectError', { error })}</Callout>
      ) : scorecards.length === 0 ? (
        <EmptyState title={t('emptyScorecardsTitle')} hint={t('emptyScorecardsHint')} />
      ) : (
        <CustomAnalyzer
          scorecards={scorecards}
          authors={authors}
          initialConfig={storedToConfig(view.config)}
          savedViews={savedViews}
          currentSubject={subject}
          canManage={canManage}
          isAdmin={isAdmin}
          activeViewId={view.id}
        />
      )}

      <CommentsSection
        workspace={workspace}
        resourceType="view"
        resourceId={id}
        title={t('discuss')}
      />
    </div>
  )
}
