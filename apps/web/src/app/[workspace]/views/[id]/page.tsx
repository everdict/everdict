import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

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
            ? '워크스페이스 공유 뷰 · 현재 데이터로 실시간 집계'
            : '비공개 뷰 · 현재 데이터로 실시간 집계'
        }
        actions={
          <Link
            href={`/${workspace}/views`}
            className={buttonVariants({ size: 'sm', variant: 'secondary' })}
          >
            <ArrowLeft className="size-4" /> 뷰 목록
          </Link>
        }
      />
      {error ? (
        <Callout tone="danger">서버에 연결하지 못했어요: {error}</Callout>
      ) : scorecards.length === 0 ? (
        <EmptyState
          title="아직 스코어카드가 없어요."
          hint="스코어카드를 실행하면 이 뷰가 채워져요."
        />
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

      <CommentsSection workspace={workspace} resourceType="view" resourceId={id} title="논의" />
    </div>
  )
}
