import Link from 'next/link'
import { getTranslations } from 'next-intl/server'

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
  const t = await getTranslations('scorecardsPage')
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
        title={t('analyze')}
        description={mode === 'custom' ? t('analyzeCustomDesc') : t('analyzeEasyDesc')}
        actions={
          <div className="inline-flex overflow-hidden rounded-lg border bg-card shadow-raise">
            <Link
              href={`/${workspace}/scorecards/analyze?mode=easy`}
              className={seg(mode === 'easy')}
            >
              {t('analyzeEasy')}
            </Link>
            <Link
              href={`/${workspace}/scorecards/analyze?mode=custom`}
              className={cn(seg(mode === 'custom'), 'border-l border-border')}
            >
              {t('analyzeCustom')}
            </Link>
          </div>
        }
      />
      {error ? (
        <Callout tone="danger">{t('connectError', { error })}</Callout>
      ) : scorecards.length === 0 ? (
        <EmptyState title={t('emptyTitle')} hint={t('analyzeEmptyHint')} />
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
