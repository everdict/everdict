import { ScorecardAnalyzer, type QuestionId } from '@/features/analyze-scorecards'
import { membersSchema } from '@/entities/member'
import { scorecardsSchema } from '@/entities/scorecard'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// 스코어카드 통합 분석 — 필터·그룹·측정·검색으로 리더보드/하니스별/추이/비교를 한 화면에서.
// AnalysisConfig 는 URL 쿼리에 실려 딥링크/공유된다. 설계: docs/architecture/scorecard-analysis-views.md.
export default async function AnalyzePage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await params
  const sp = await searchParams
  const rawQ = Array.isArray(sp.q) ? sp.q[0] : sp.q
  const initialQuestion: QuestionId = rawQ === 'models' || rawQ === 'harnesses' ? rawQ : 'trend'
  const initialHarness = (Array.isArray(sp.h) ? sp.h[0] : sp.h) ?? ''
  const nowIso = new Date().toISOString()

  const { ctx } = await currentPrincipal()
  let error: string | undefined
  let scorecards = scorecardsSchema.parse([])
  try {
    scorecards = scorecardsSchema.parse(await controlPlane.listScorecards(ctx))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])
  const authors: Record<string, { name: string; avatarUrl?: string }> = {}
  for (const m of members)
    authors[m.subject] = {
      name: m.name ?? m.email?.split('@')[0] ?? m.subject,
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    }

  return (
    <div className="space-y-6">
      <PageHeader title="분석" description="성능 추이·모델 비교·하니스 비교를 골라 바로 봐요." />
      {error ? (
        <Callout tone="danger">서버에 연결하지 못했어요: {error}</Callout>
      ) : scorecards.length === 0 ? (
        <EmptyState
          title="아직 스코어카드가 없어요."
          hint="스코어카드를 실행하면 여기서 분석할 수 있어요."
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
