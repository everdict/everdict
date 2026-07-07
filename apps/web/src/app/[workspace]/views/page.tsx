import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

import { loadAnalysisData, ViewList } from '@/features/analyze-scorecards'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 저장된 분석 뷰 — 1급 객체. 목록/관리 + 열기(라이브 재실행). 만들기는 분석 대시보드(커스텀)에서.
export default async function ViewsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('viewsPage')
  const { savedViews, authors, subject, isAdmin, error } = await loadAnalysisData()

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Link
            href={`/${workspace}/scorecards/analyze?mode=custom`}
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
              href={`/${workspace}/scorecards/analyze?mode=custom`}
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
        />
      )}
    </div>
  )
}
