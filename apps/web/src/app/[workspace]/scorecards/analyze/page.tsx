import Link from 'next/link'

import {
  CustomAnalyzer,
  loadAnalysisData,
  paramsToConfig,
  ScorecardAnalyzer,
  storedToConfig,
  type QuestionId,
} from '@/features/analyze-scorecards'
import { cn } from '@/shared/lib/utils'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 스코어카드 분석 — 쉬운(질문 3개) · 커스텀(유연 피벗) 두 모드. 저장된 뷰는 1급 객체(/{ws}/views).
// 설계: docs/architecture/scorecard-analysis-views.md.
export default async function AnalyzePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { workspace } = await params
  const sp = await searchParams
  const flat: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(sp)) flat[k] = Array.isArray(v) ? v[0] : v

  const initialQuestion: QuestionId =
    flat.q === 'models' || flat.q === 'harnesses' ? flat.q : 'trend'
  const initialHarness = flat.h ?? ''
  const nowIso = new Date().toISOString()

  const { scorecards, authors, savedViews, subject, canManage, isAdmin, error } =
    await loadAnalysisData()

  // ?view=<id> 딥링크 — 저장된 View 를 열면 그 config 로 커스텀 모드 진입(라이브 재실행).
  const linkedView = flat.view ? savedViews.find((v) => v.id === flat.view) : undefined
  const mode = flat.mode === 'custom' || linkedView ? 'custom' : 'easy'

  const seg = (active: boolean) =>
    cn(
      'px-3 py-1.5 text-[12px] font-[510] transition-colors',
      active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
    )

  return (
    <div className="space-y-6">
      <PageHeader
        title="분석"
        description={
          mode === 'custom'
            ? '필터·그룹·측정을 직접 짜서 원하는 표를 만들어요.'
            : '성능 추이·모델 비교·하니스 비교를 골라 바로 봐요.'
        }
        actions={
          <div className="inline-flex overflow-hidden rounded-lg border bg-card shadow-raise">
            <Link
              href={`/${workspace}/scorecards/analyze?mode=easy`}
              className={seg(mode === 'easy')}
            >
              쉬운 분석
            </Link>
            <Link
              href={`/${workspace}/scorecards/analyze?mode=custom`}
              className={cn(seg(mode === 'custom'), 'border-l border-border')}
            >
              커스텀 분석
            </Link>
          </div>
        }
      />
      {error ? (
        <Callout tone="danger">서버에 연결하지 못했어요: {error}</Callout>
      ) : scorecards.length === 0 ? (
        <EmptyState
          title="아직 스코어카드가 없어요."
          hint="스코어카드를 실행하면 여기서 분석할 수 있어요."
        />
      ) : mode === 'custom' ? (
        <CustomAnalyzer
          scorecards={scorecards}
          authors={authors}
          initialConfig={linkedView ? storedToConfig(linkedView.config) : paramsToConfig(flat)}
          savedViews={savedViews}
          currentSubject={subject}
          canManage={canManage}
          isAdmin={isAdmin}
          activeViewId={linkedView?.id}
        />
      ) : (
        <ScorecardAnalyzer
          scorecards={scorecards}
          authors={authors}
          nowIso={nowIso}
          initialQuestion={initialQuestion}
          initialHarness={initialHarness}
        />
      )}
    </div>
  )
}
