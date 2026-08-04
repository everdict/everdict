import { CalendarClock } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { IssueListView, type IssueListFilters } from '@/widgets/issue-list'
import { TeamScopeBar, type TeamScope } from '@/widgets/team-scope-bar'
import { CommentsSection } from '@/features/discuss'
import { CompleteCycleButton, CreateCycleButton } from '@/features/manage-cycle'
import {
  CycleBurndownChart,
  cycleDetailSchema,
  cycleHref,
  cycleIndexHref,
  cycleLabel,
  cyclesSchema,
  CycleStateBadge,
  cycleStateOf,
  daysRemaining,
  landingCycleOf,
  todayIso,
  type Cycle,
  type CycleDetail,
} from '@/entities/cycle'
import { memberDirectoryOf, membersSchema, type Member } from '@/entities/member'
import { type TeamWithSummary } from '@/entities/team'
import { TrackerHistory } from '@/entities/tracker-history'
import { canInTeam } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { DistributionBar } from '@/shared/ui/distribution-bar'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { StatCard } from '@/shared/ui/stat-card'

import { CycleSwitcher, type CycleSwitcherOption } from './cycle-switcher'

// 한 이터레이션의 보드 — "지금 이 주기에 무엇을 하고 있고, 어떻게 가고 있나". 리니어와 같은 랜딩이다:
// 팀의 Cycles 를 누르면 목록이 아니라 지금 돌고 있는 사이클이 열리고, 제목이 곧 다른 사이클로 가는 스위처다.
//
// 목록은 새로 만들지 않고 `IssueListView` 를 사이클 스코프로 부른다 — 묶기·필터·보드 레이아웃이 이슈 화면과
// 같은 한 벌이어야 하고, 두 벌이 되는 순간 둘은 어긋나기 시작한다.
export async function CycleBoardView({
  workspace,
  team,
  // 볼 사이클의 번호. 없으면 랜딩(지금 돌고 있는 것 → 다음 것 → 가장 최근 것).
  number,
  filters,
}: {
  workspace: string
  team: TeamWithSummary
  number?: number
  filters: IssueListFilters
}) {
  const t = await getTranslations('cyclesPage')
  const { principal, ctx } = await currentPrincipal()
  const canWrite = canInTeam(principal, 'issues:write', team.id)
  const today = todayIso()
  const scope: TeamScope = { workspace, team, section: 'cycles' }

  // 팀 스코프 읽기가 곧 파이프라인 보충 지점이다 — 사이클을 켠 팀은 이 읽기 뒤에 언제나 "지금 있는 하나"를
  // 갖는다. 그래서 여기서 빈 목록이 나온다는 건 팀이 사이클을 쓰지 않는다는 뜻이다.
  let cycles: Cycle[] = []
  let error: string | undefined
  try {
    cycles = cyclesSchema.parse(await controlPlane.listCycles(ctx, { team: team.id }))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (error !== undefined) {
    return (
      <div className="@container space-y-6">
        <TeamScopeBar scope={scope} />
        <PageHeader title={t('title')} />
        <Callout tone="danger">{t('loadError', { error })}</Callout>
      </div>
    )
  }

  // 사이클을 켜지 않은 팀. 빈 목록이 아니라 "무엇인지와 어디서 켜는지"를 말한다 — 아무것도 없는 화면은
  // 고장과 구분되지 않는다.
  if (cycles.length === 0) {
    return (
      <div className="@container space-y-6">
        <TeamScopeBar scope={scope} />
        <PageHeader
          title={t('title')}
          description={t('description')}
          {...(canWrite ? { actions: <CreateCycleButton teamId={team.id} /> } : {})}
        />
        <EmptyState
          icon={<CalendarClock strokeWidth={1.75} />}
          title={team.cyclesEnabled ? t('emptyTitle') : t('disabledTitle')}
          hint={team.cyclesEnabled ? t('emptyHint', { team: team.name }) : t('disabledHint')}
        />
      </div>
    )
  }

  const current = number === undefined ? landingCycleOf(cycles, today) : cycles.find((c) => c.number === number)
  if (!current) {
    return (
      <div className="@container space-y-6">
        <TeamScopeBar scope={scope} />
        <PageHeader title={t('title')} />
        <Callout tone="danger">{t('unknownNumber', { number: number ?? 0 })}</Callout>
      </div>
    )
  }

  // 상세는 이 사이클 하나에 대해서만 부른다 — 진행도와 번다운은 사이클의 이슈들 위로 팬아웃하는 읽기라
  // 목록의 모든 행에 붙일 수 없다(그래서 목록 응답은 얇다). 멤버 디렉터리는 이력이 이름·얼굴을 붙이는 데만
  // 쓰이므로 실패해도 자기 자리만 비운다.
  const [detail, members] = await Promise.all([
    controlPlane
      .getCycle(ctx, current.id)
      .then((r) => cycleDetailSchema.parse(r))
      .catch((): CycleDetail | undefined => undefined),
    controlPlane
      .listMembers(ctx)
      .then((r) => membersSchema.parse(r))
      .catch((): Member[] => []),
  ])

  const state = cycleStateOf(current, today)
  const left = daysRemaining(current, today)
  const options: CycleSwitcherOption[] = cycles.map((cycle) => ({
    number: cycle.number,
    label: cycleLabel(cycle),
    state: cycleStateOf(cycle, today),
    href: cycleHref(workspace, team.key, cycle.number),
  }))
  // 이월 대상 — 같은 팀의 열린 사이클, 자기 자신은 제외(다른 팀으로는 서버도 거절한다).
  const carryTargets = cycles
    .filter((cycle) => cycle.completedAt === undefined && cycle.id !== current.id)
    .map((cycle) => ({ id: cycle.id, label: cycleLabel(cycle) }))
  const progress = detail?.progress

  return (
    <div className="@container space-y-5">
      <TeamScopeBar scope={scope} />

      {/* ① 제목 = 스위처, 그 옆에 상태와 창. 남은 날은 진행 중일 때만 신호다 — 끝난 주기에 "0일 남음"을
          붙이면 경고가 배경이 된다. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <CycleSwitcher
          current={current}
          options={options}
          indexHref={cycleIndexHref(workspace, team.key)}
        />
        <CycleStateBadge state={state} />
        <span className="font-mono text-[11.5px] text-muted-foreground">
          {current.startsAt} → {current.endsAt}
        </span>
        {state === 'active' && (
          <span className="text-[12px] text-muted-foreground">{t('daysLeft', { count: left })}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {canWrite && state !== 'completed' && (
            <CompleteCycleButton
              id={current.id}
              openCycles={carryTargets}
              unfinished={progress?.open ?? 0}
            />
          )}
          {canWrite && <CreateCycleButton teamId={team.id} />}
        </div>
      </div>
      {current.description !== undefined && (
        <p className="text-[13px] leading-relaxed text-muted-foreground">{current.description}</p>
      )}

      {/* ② 얼마나 왔나 — 개수와 포인트를 나란히. 추정 없는 이슈는 개수에만 실린다. */}
      {progress !== undefined && (
        <div className="space-y-3">
          <div className="grid gap-3 @md:grid-cols-2 @2xl:grid-cols-4">
            <StatCard
              label={t('statOpen')}
              value={progress.open}
              tone={progress.open > 0 ? 'danger' : 'success'}
            />
            <StatCard label={t('statDone')} value={progress.done} />
            <StatCard label={t('statScope')} value={`${progress.completedScope}/${progress.scope}`} />
            <StatCard label={t('statEstimated')} value={`${progress.estimated}/${progress.total}`} />
          </div>
          {progress.total > 0 && (
            <DistributionBar
              segments={[
                { label: t('statDone'), count: progress.done },
                { label: t('statOpen'), count: progress.open },
              ]}
            />
          )}
        </div>
      )}

      {/* ③ 번다운 — 시작하지도 않은 사이클에는 그릴 것이 없다(빈 축은 정보가 아니라 소음이다). */}
      {detail !== undefined && detail.burndown.length > 0 && (
        <CycleBurndownChart cycle={current} burndown={detail.burndown} />
      )}

      {/* ④ 이 이터레이션의 보드. 이슈 목록 한 벌을 사이클 스코프로 부른다. */}
      <IssueListView
        workspace={workspace}
        team={team}
        cycle={{ id: current.id, basePath: cycleHref(workspace, team.key, current.number) }}
        filters={filters}
      />

      {/* ⑤ 이 이터레이션에 대한 기록과 대화 — 계획이 언제 바뀌었고 왜 그랬는지는 회고가 찾는 것이다. */}
      <section className="space-y-3 pt-2">
        <SectionHeader title={t('historyTitle')} />
        <TrackerHistory
          kind="cycle"
          subject={cycleLabel(current)}
          entries={current.history}
          actors={memberDirectoryOf(members)}
          workspace={workspace}
        />
      </section>
      <CommentsSection workspace={workspace} resourceType="cycle" resourceId={current.id} />
    </div>
  )
}
