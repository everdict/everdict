import { ChevronRight, CircleDot } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { EvalDashboard } from '@/widgets/eval-dashboard'
import { RunsTable } from '@/widgets/runs-table'
import { InitiativeProgress, RegressedIssues } from '@/widgets/tracker-overview'
import {
  initiativeDetailSchema,
  initiativesSchema,
  type InitiativeDetail,
} from '@/entities/initiative'
import { issuePageSchema, type IssueSummary } from '@/entities/issue'
import { runsSchema } from '@/entities/run'
import { scorecardsSchema } from '@/entities/scorecard'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'

export const dynamic = 'force-dynamic'

// 오버뷰는 사이드바와 같은 순서로 답한다: 먼저 "내보내도 되나"(이니셔티브 readiness), 다음 "무엇이 무너졌나"(회귀),
// 그다음에야 "무엇이 돌았나"(평가 활동). readiness 는 detail 읽기에서만 계산되므로(목록은 경량 유지) 활성 이니셔티브
// 몇 개만 상세로 가져온다 — 홈이 워크스페이스 전체를 훑지 않도록 명시적으로 캡을 둔다.
const READINESS_CARDS = 4
const REGRESSION_ROWS = 6

function ViewAll({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      {label}
      <ChevronRight className="size-3.5" />
    </Link>
  )
}

export default async function OverviewPage({ params }: { params: Promise<{ workspace: string }> }) {
  const { workspace } = await params
  const t = await getTranslations('overviewPage')
  const ctx = await authContext()
  let error: string | undefined
  let runs = runsSchema.parse([])
  let scorecards = scorecardsSchema.parse([])
  let regressed: IssueSummary[] = []
  let readiness: InitiativeDetail[] = []
  try {
    const [r, sc, active, reg] = await Promise.all([
      controlPlane.listRuns(ctx),
      controlPlane.listScorecards(ctx),
      controlPlane.listInitiatives(ctx, { status: 'active', limit: READINESS_CARDS }),
      controlPlane.listIssues(ctx, { status: ['regressed'], limit: REGRESSION_ROWS }),
    ])
    runs = runsSchema.parse(r)
    scorecards = scorecardsSchema.parse(sc)
    regressed = issuePageSchema.parse(reg).items
    // 이니셔티브별 readiness 는 도메인 산식이라 서버가 계산한다 — 웹이 다시 구현하면 두 곳이 갈라진다.
    // 하나가 실패해도 나머지 카드는 살린다.
    readiness = (
      await Promise.all(
        initiativesSchema.parse(active).map((i) =>
          controlPlane
            .getInitiative(ctx, i.id)
            .then((d) => initiativeDetailSchema.parse(d))
            .catch(() => undefined)
        )
      )
    ).filter((d): d is InitiativeDetail => d !== undefined)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  // 남은 일이 있는 목표가 먼저 — 다 이룬 것은 볼 일이 없다.
  const orderedReadiness = [...readiness].sort(
    (a, b) => Number(a.readiness.ready) - Number(b.readiness.ready)
  )

  return (
    <div className="@container space-y-7">
      <PageHeader title={t('title')} description={t('description')} />

      {error ? (
        <Callout tone="danger" hint={t('connectErrorHint')}>
          {t('connectError', { error })}
        </Callout>
      ) : (
        <>
          <section className="space-y-2.5">
            <SectionHeader
              title={t('initiativeProgress')}
              action={<ViewAll href={`/${workspace}/initiatives`} label={t('viewAll')} />}
            />
            {orderedReadiness.length === 0 ? (
              <EmptyState
                icon={<CircleDot />}
                title={t('emptyInitiativesTitle')}
                hint={t('emptyInitiativesHint')}
              />
            ) : (
              <InitiativeProgress workspace={workspace} initiatives={orderedReadiness} />
            )}
          </section>

          {/* 회귀가 없으면 섹션째 숨긴다 — "이상 없음" 카드는 매일 보면 노이즈다. */}
          {regressed.length > 0 && (
            <section className="space-y-2.5">
              <SectionHeader
                title={t('regressions')}
                action={
                  <ViewAll href={`/${workspace}/issues?status=regressed`} label={t('viewAll')} />
                }
              />
              <RegressedIssues workspace={workspace} issues={regressed} />
            </section>
          )}

          <EvalDashboard scorecards={scorecards} workspace={workspace} />
        </>
      )}

      <section className="space-y-2.5">
        <SectionHeader
          title={t('recentRuns')}
          action={<ViewAll href={`/${workspace}/runs`} label={t('viewAll')} />}
        />
        <RunsTable runs={runs} workspace={workspace} limit={5} />
      </section>
    </div>
  )
}
