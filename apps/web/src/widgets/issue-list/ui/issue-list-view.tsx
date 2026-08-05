import { Suspense } from 'react'
import { cookies } from 'next/headers'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { TeamScopeBar, type TeamScope } from '@/widgets/team-scope-bar'
import {
  IssueBulkBar,
  IssueListBody,
  IssueSelectionProvider,
  loadIssueViewData,
  type IssueDirectories,
  type IssueViewBase,
} from '@/features/browse-issues'
import { cycleLabel, cyclesSchema, cycleStateOf, todayIso, type Cycle } from '@/entities/cycle'
import {
  ISSUE_DISPLAY_COOKIE,
  issueDisplayFor,
  issueViewKeyOf,
  issueViewOf,
  type IssueViewParams,
} from '@/entities/issue'
import { issueLabelDirectoryOf, issueLabelsSchema, type IssueLabel } from '@/entities/issue-label'
import { memberDirectoryOf, membersSchema, type Member } from '@/entities/member'
import { projectsSchema, type Project } from '@/entities/project'
import { teamSectionHref, teamsWithSummarySchema, type TeamWithSummary } from '@/entities/team'
import { can, canInTeam } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'

import { IssueListActions, IssueListActionsSkeleton } from './issue-list-actions'

export type IssueListFilters = IssueViewParams

// The eval tracker's issue list (docs/tracker.md) — "what are we evaluating, and what came back". A regressed
// issue is not untouched work: it carries the resolution it fell from, so it reads as an alarm in every list.
//
// ONE component behind THREE addresses: `/{workspace}/issues` (every team's), `/{workspace}/team/ENG` and its
// `/issues` twin (that team's), plus `/triage` for a team's inbox. The team is a PATH, not a query parameter —
// a list scoped to a team is a different resource, not the same resource filtered.
//
// The screen is assembled from two sources on purpose: the FILTERS come from the URL (they decide which issues,
// so a pasted link has to reproduce them) and the DISPLAY comes from the reader's cookie, keyed by this list's
// address (it decides only how they are drawn, so a link must not impose it). `entities/issue/model/display.ts`
// carries the full reasoning.
//
// 서버가 하는 일은 **첫 화면**까지다 — 디렉터리(멤버·프로젝트·라벨·사이클)와 목록의 첫 장을 읽어 넘기면,
// 그 뒤로 보기를 바꾸는 것은 전부 `IssueListBody` 가 목록만 새로 받아 처리한다. 그래서 필터 하나를 켜는 데
// 이 페이지 전체가 다시 렌더되지 않는다(그게 "그룹 바꾸면 왜 이렇게 오래 걸리지"의 정체였다).
export async function IssueListView({
  workspace,
  team,
  triage,
  cycle,
  filters,
}: {
  workspace: string
  // 팀 스코프일 때만. 없으면 워크스페이스 전체 목록이다.
  team?: TeamWithSummary
  // 팀의 트리아지 인박스 — 워크플로 앞에 앉은 큐. 팀 아래에서만 존재한다.
  triage?: boolean
  // 한 이터레이션의 보드. 사이클 화면은 자기 헤더(진행도·번다운·닫기)를 이미 그렸으므로 여기서는 툴바부터
  // 시작하고, 필터·표시 링크도 사이클 주소를 기준으로 만든다 — 목록을 두 벌 만들지 않기 위한 네 번째 주소다.
  cycle?: { id: string; basePath: string }
  filters: IssueListFilters
}) {
  const t = await getTranslations('issuesPage')
  const timeZone = await getTimeZone()
  const { principal, ctx } = await currentPrincipal()
  // Which list this is, for the purpose of remembering how it is drawn. The team is named by its KEY rather than
  // its id so the stored preference stays readable and survives nothing in particular being renamed.
  const viewKey = issueViewKeyOf({ team: team?.key, triage, cycle: cycle !== undefined })
  const display = issueDisplayFor((await cookies()).get(ISSUE_DISPLAY_COOKIE)?.value, viewKey)
  const view = issueViewOf(filters, display)

  // 쓰기 버튼은 역할 + 팀 두 축을 모두 통과해야 뜬다 — 속하지 않은 팀의 목록에서 「이슈 만들기」를 내밀면
  // 제어 평면이 403 을 줄 게 확실한 버튼을 보여 주는 것이다(강제는 여전히 제어 평면 몫).
  const canWrite = canInTeam(principal, 'issues:write', team?.id)
  // The import picker needs the workspace App's repo list, and that read is settings:read (admin) — so the entry
  // point is only offered to someone who can actually complete the flow. A member keeps the whole sync surface
  // (bulk pull, per-issue sync, toggles): those ride issues:write and never touch the App configuration.
  const canReadIntegrations = can(principal?.roles ?? [], 'settings:read')

  // 주소가 정한 좁히기 — 보기를 바꿔도 변하지 않는 부분이다.
  const base: IssueViewBase = {
    ...(team ? { team: team.id } : {}),
    ...(triage ? { triage: true } : {}),
    ...(cycle ? { cycle: cycle.id } : {}),
  }

  // 팀 목록은 두 소비자가 있다 — 워크스페이스 전체 목록의 팀 칩(임계 경로)과 「이슈 만들기」의 팀 선택
  // (스트리밍되는 툴바). 호출은 한 번, 기다리는 것은 칩이 실제로 그려지는 화면에서만.
  const teamsPromise = controlPlane
    .listTeams(ctx)
    .then((r) => teamsWithSummarySchema.parse(r))
    .catch((): TeamWithSummary[] => [])

  // 이 읽기들은 서로를 기다릴 이유가 없다 — 순차 await 이면 왕복 시간이 그대로 더해진다. 목록만 실패를
  // 표면에 올리고, 나머지는 자기 자리만 비운다.
  const [data, teams, projects, cycles, labels, members] = await Promise.all([
    loadIssueViewData(ctx, { base, view }),
    // 팀 칩은 워크스페이스 전체 목록에서만 그려진다 — 팀 스코프에서는 기다릴 이유가 없다.
    team ? Promise.resolve<TeamWithSummary[]>([]) : teamsPromise,
    // Projects power both the filter and the per-row project name; a failure here must not blank the list.
    controlPlane
      .listProjects(ctx, team ? { team: team.id } : undefined)
      .then((r) => projectsSchema.parse(r))
      .catch((): Project[] => []),
    // 사이클은 팀의 것이다 — 워크스페이스 전체 목록에서는 고를 대상이 없으므로 아예 읽지 않는다.
    team
      ? controlPlane
          .listCycles(ctx, { team: team.id })
          .then((r) => cyclesSchema.parse(r))
          .catch((): Cycle[] => [])
      : Promise.resolve<Cycle[]>([]),
    // 행의 라벨 칩은 id→정의 조인이 있어야 그려진다. 실패해도 목록은 뜬다(칩만 사라진다).
    controlPlane
      .listIssueLabels(ctx)
      .then((r) => issueLabelsSchema.parse(r))
      .catch((): IssueLabel[] => []),
    // 담당자는 이슈에 subject 로만 저장된다 — 그대로 그리면 uuid 나 `key:acme` 같은 내부 문자열이 뜬다.
    // 상세 페이지와 같은 디렉터리 조인으로 이름·아바타를 붙인다(라벨·프로젝트와 같은 조인).
    controlPlane
      .listMembers(ctx)
      .then((r) => membersSchema.parse(r))
      .catch((): Member[] => []),
  ])

  const actors = memberDirectoryOf(members)
  const directories: IssueDirectories = {
    projectName: Object.fromEntries(projects.map((p) => [p.id, p.name])),
    cycleName: Object.fromEntries(cycles.map((c) => [c.id, cycleLabel(c)])),
    labels: issueLabelDirectoryOf(labels),
    actors,
    members: members.map((m) => ({
      subject: m.subject,
      name: actors[m.subject]?.name ?? m.subject,
      ...(m.avatarUrl !== undefined ? { avatarUrl: m.avatarUrl } : {}),
    })),
  }

  // 이 목록의 주소. 사이클 보드면 그 사이클의 주소, 팀 스코프면 팀 아래의 경로 자원, 아니면 워크스페이스
  // 전체 목록이다.
  const basePath = cycle
    ? cycle.basePath
    : team
      ? teamSectionHref(workspace, team.key, triage ? 'triage' : 'issues')
      : `/${workspace}/issues`

  // 사이클 보드는 위치도 제목도 이미 그렸다 — 여기서 한 번 더 그리면 한 화면에 헤더가 둘이 된다.
  const teamScope: TeamScope | undefined =
    team && !cycle ? { workspace, team, section: triage ? 'triage' : 'issues' } : undefined

  // 일괄 편집이 있는 곳은 팀 스코프뿐이다 — 이슈는 자기 팀의 사이클에만 들어가므로(제어 평면이 거절한다),
  // 여러 팀이 섞인 워크스페이스 목록에서는 "이 사이클로"가 성립하지 않는다. 고를 수 있는 것은 열린 사이클뿐.
  const today = todayIso()
  const bulkCycles =
    team && canWrite
      ? cycles
          .filter((c) => c.completedAt === undefined)
          .map((c) => ({ id: c.id, label: cycleLabel(c), state: cycleStateOf(c, today) }))
      : []

  const body = (
    <div className="@container space-y-4">
      {teamScope && <TeamScopeBar scope={teamScope} />}
      {!cycle && (
        <PageHeader
          title={triage ? t('triageTitle') : team ? team.name : t('title')}
          description={
            triage
              ? t('triageDescription')
              : team
                ? (team.description ?? undefined)
                : t('description')
          }
          actions={
            canWrite ? (
              // 버튼 세 개가 GitHub App 설치 상태와 동기화 저장소 목록을 기다린다 — 그 대기를 목록의 임계
              // 경로에서 떼어 자기 경계 뒤로 보낸다.
              <Suspense fallback={<IssueListActionsSkeleton />}>
                <IssueListActions
                  workspace={workspace}
                  teams={teamsPromise}
                  projects={projects.map((p) => ({ id: p.id, name: p.name }))}
                  cycles={bulkCycles.map((c) => ({ id: c.id, name: c.label }))}
                  {...(team ? { defaultTeamId: team.id, team } : {})}
                  canReadIntegrations={canReadIntegrations}
                />
              </Suspense>
            ) : null
          }
        />
      )}

      <IssueListBody
        workspace={workspace}
        basePath={basePath}
        viewKey={viewKey}
        base={base}
        initialView={view}
        initialData={data}
        directories={directories}
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        cycles={cycles.map((c) => ({ id: c.id, name: cycleLabel(c) }))}
        canWrite={canWrite}
        timeZone={timeZone}
        chips={
          // 팀 칩은 필터가 아니라 그 팀의 목록으로 가는 링크다 — 워크스페이스 전체 목록에서, 팀이 둘 이상일 때만.
          !team && teams.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {teams.map((x) => (
                <Link
                  key={x.id}
                  href={teamSectionHref(workspace, x.key, 'issues')}
                  className="rounded-full border border-border px-2.5 py-0.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  <span className="font-mono">{x.key}</span>
                </Link>
              ))}
            </div>
          ) : undefined
        }
        footer={bulkCycles.length > 0 ? <IssueBulkBar cycles={bulkCycles} /> : undefined}
      />
    </div>
  )

  // 고를 대상이 없는 목록(워크스페이스 전체, 읽기 전용)에는 프로바이더를 씌우지 않는다 — 행이 체크박스 자리를
  // 내주지 않고 예전 그대로 그려진다.
  return bulkCycles.length > 0 ? <IssueSelectionProvider>{body}</IssueSelectionProvider> : body
}
