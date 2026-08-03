import Link from 'next/link'
import { CalendarClock } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { TeamScopeBar, type TeamScope } from '@/widgets/team-scope-bar'
import { CreateCycleButton } from '@/features/manage-cycle'
import { cycleLabel, cyclesSchema, CycleStateBadge, type Cycle } from '@/entities/cycle'
import { type TeamWithSummary } from '@/entities/team'
import { canInTeam } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

// 팀의 이터레이션 목록. 상태는 저장된 값이 아니라 날짜 + "닫혔는가"에서 나오므로 여기서 판정한다 — 서버가
// 상세에서 쓰는 것과 같은 규칙이고, 한 응답 안의 모든 행이 같은 날짜를 기준으로 읽히도록 today 를 한 번만 잡는다.
function stateOf(cycle: Cycle, today: string): 'upcoming' | 'active' | 'completed' {
  if (cycle.completedAt !== undefined) return 'completed'
  return today < cycle.startsAt ? 'upcoming' : 'active'
}

// 사이클은 언제나 한 팀의 것이다 — "Cycle 3"은 그 팀의 세 번째다. 그래서 주소도 팀 아래에만 있다
// (`/{workspace}/teams/ENG/cycles`): 워크스페이스 전체 사이클 목록은 누구의 세 번째인지 답하지 못하는 화면이라
// 만들지 않는다.
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
  const today = new Date().toISOString().slice(0, 10)
  const scope: TeamScope = { workspace, team, section: 'cycles' }

  return (
    <div className="@container space-y-6">
      <TeamScopeBar scope={scope} />
      <PageHeader
        title={t('title')}
        description={t('description')}
        {...(canWrite ? { actions: <CreateCycleButton teamId={team.id} /> } : {})}
      />

      {error ? (
        <Callout tone="danger">{t('loadError', { error })}</Callout>
      ) : cycles.length === 0 ? (
        <EmptyState
          icon={<CalendarClock strokeWidth={1.75} />}
          title={t('emptyTitle')}
          hint={t('emptyHint', { team: team.name })}
        />
      ) : (
        <div className="space-y-2">
          {cycles.map((cycle) => (
            <Link
              key={cycle.id}
              href={`/${workspace}/cycles/${encodeURIComponent(cycle.id)}`}
              className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
            >
              <span className="min-w-0 flex-1 truncate text-[13px] font-[510] text-foreground">
                {cycleLabel(cycle)}
              </span>
              <CycleStateBadge state={stateOf(cycle, today)} />
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {cycle.startsAt} → {cycle.endsAt}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
