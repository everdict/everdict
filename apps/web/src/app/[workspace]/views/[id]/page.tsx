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

// 저장된 뷰 열기 — 1급 URL(/{ws}/views/{id}). config 로 대시보드를 채우고 현재 데이터로 재실행(라이브).
// 남의 비공개/없는 뷰는 목록(listVisible)에 안 잡히므로 notFound(404) — 존재 누출 금지.
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
