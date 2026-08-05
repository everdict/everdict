import { CalendarClock } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { TeamScopeBar, type TeamScope } from '@/widgets/team-scope-bar'
import { CreateCycleButton } from '@/features/manage-cycle'
import {
  cycleHref,
  cycleLabel,
  cyclesSchema,
  CycleStateBadge,
  cycleStateOf,
  daysRemaining,
  todayIso,
  type Cycle,
  type CycleState,
} from '@/entities/cycle'
import { type TeamWithSummary } from '@/entities/team'
import { canInTeam } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'

// 팀의 이터레이션 전부 — `/{workspace}/teams/ENG/cycles/all`. 사이클은 언제나 한 팀의 것이라("Cycle 3"은 그
// 팀의 세 번째다) 워크스페이스 수준의 주소가 없다. 랜딩(`…/cycles`)이 지금 돌고 있는 하나를 여므로, 이 화면의
// 일은 "그 앞뒤에 무엇이 있었나"를 시간 순서대로 보여 주는 것뿐이다.
//
// 상태로 묶는다 — 진행 중 · 예정 · 완료. 날짜만 늘어놓으면 "지금 어느 것인가"를 사람이 다시 계산해야 한다.
const SECTIONS: CycleState[] = ['active', 'upcoming', 'completed']

export async function CycleListView({
  workspace,
  team,
}: {
  workspace: string
  team: TeamWithSummary
}) {
  const t = await getTranslations('cyclesPage')
  const { principal, ctx } = await currentPrincipal()

  let cycles: Cycle[] = []
  let error: string | undefined
  try {
    cycles = cyclesSchema.parse(await controlPlane.listCycles(ctx, { team: team.id }))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  const canWrite = canInTeam(principal, 'issues:write', team.id)
  // 한 응답의 모든 행이 같은 날짜로 판정되도록 오늘을 한 번만 잡는다.
  const today = todayIso()
  const scope: TeamScope = { workspace, team, section: 'cycles' }
  const grouped = SECTIONS.map((state) => ({
    state,
    rows: cycles.filter((cycle) => cycleStateOf(cycle, today) === state),
  })).filter((group) => group.rows.length > 0)

  return (
    <div className="@container space-y-6">
      <TeamScopeBar scope={scope} />
      <PageHeader
        title={t('allTitle')}
        description={t('description')}
        {...(canWrite ? { actions: <CreateCycleButton teamId={team.id} /> } : {})}
      />

      {error ? (
        <Callout tone="danger">{t('loadError', { error })}</Callout>
      ) : cycles.length === 0 ? (
        <EmptyState
          icon={<CalendarClock strokeWidth={1.75} />}
          title={team.cyclesEnabled ? t('emptyTitle') : t('disabledTitle')}
          hint={team.cyclesEnabled ? t('emptyHint', { team: team.name }) : t('disabledHint')}
        />
      ) : (
        <div className="space-y-6">
          {grouped.map((group) => (
            <section key={group.state} className="space-y-2">
              <SectionHeader title={t(`section.${group.state}`, { count: group.rows.length })} />
              <div className="space-y-2">
                {group.rows.map((cycle) => (
                  <Link
                    key={cycle.id}
                    href={cycleHref(workspace, team.key, cycle.number)}
                    className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px] font-[510] text-foreground">
                      {cycleLabel(cycle)}
                    </span>
                    <CycleStateBadge state={group.state} />
                    {/* 남은 날은 진행 중일 때만 신호다 — 끝난 주기에 붙이면 경고가 배경이 된다. */}
                    {group.state === 'active' && (
                      <span className="shrink-0 text-[11.5px] text-muted-foreground">
                        {t('daysLeft', { count: daysRemaining(cycle, today) })}
                      </span>
                    )}
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      {cycle.startsAt} → {cycle.endsAt}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
