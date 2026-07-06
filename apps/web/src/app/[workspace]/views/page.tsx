import Link from 'next/link'

import { loadAnalysisData, ViewList } from '@/features/analyze-scorecards'
import { buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 저장된 분석 뷰 — 1급 객체. 목록/관리 + 열기(라이브 재실행). 만들기는 분석 대시보드(커스텀)에서.
export default async function ViewsPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const { savedViews, authors, subject, isAdmin, error } = await loadAnalysisData()

  return (
    <div className="space-y-6">
      <PageHeader
        title="뷰"
        description="자주 보는 분석을 저장해 두고, 열 때마다 최신 데이터로 다시 봐요."
        actions={
          <Link
            href={`/${workspace}/scorecards/analyze?mode=custom`}
            className={buttonVariants({ size: 'sm' })}
          >
            새 분석
          </Link>
        }
      />
      {error ? (
        <Callout tone="danger">서버에 연결하지 못했어요: {error}</Callout>
      ) : savedViews.length === 0 ? (
        <EmptyState
          title="저장된 뷰가 없어요."
          hint="분석 대시보드에서 원하는 표를 만든 뒤 '현재 분석 저장'을 누르면 여기에 모여요."
          action={
            <Link
              href={`/${workspace}/scorecards/analyze?mode=custom`}
              className={buttonVariants({ size: 'sm' })}
            >
              분석 만들기
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
