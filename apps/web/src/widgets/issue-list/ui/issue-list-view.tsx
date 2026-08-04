import { Suspense } from 'react'
import { cookies } from 'next/headers'
import Link from 'next/link'
import { CircleDot } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { TeamScopeBar, type TeamScope } from '@/widgets/team-scope-bar'
import {
  IssueBoard,
  IssueBulkBar,
  IssueDisplayMenu,
  IssueFilterMenu,
  IssueGroup,
  IssueRow,
  IssueSelectionProvider,
  type IssueBoardColumn,
  type IssueDirectories,
  type IssuePageQuery,
} from '@/features/browse-issues'
import { cycleLabel, cyclesSchema, cycleStateOf, todayIso, type Cycle } from '@/entities/cycle'
import {
  ISSUE_DISPLAY_COOKIE,
  issueDisplayFor,
  issueGroupCountsSchema,
  issueGroupsToRender,
  issuePageSchema,
  issueQueryFilters,
  issueViewKeyOf,
  issueViewOf,
  orderIssueGroups,
  type IssueGroupCount,
  type IssuePage,
  type IssueViewParams,
} from '@/entities/issue'
import { issueLabelDirectoryOf, issueLabelsSchema, type IssueLabel } from '@/entities/issue-label'
import { memberDirectoryOf, membersSchema, type Member } from '@/entities/member'
import { projectsSchema, type Project } from '@/entities/project'
import { teamSectionHref, teamsWithSummarySchema, type TeamWithSummary } from '@/entities/team'
import { can, canInTeam } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

import { IssueListActions, IssueListActionsSkeleton } from './issue-list-actions'

// 그룹 하나가 처음 그리는 행 수. 묶인 화면은 그룹마다 자기 장을 갖고, 「더 보기」가 그 그룹에만 이어 붙인다.
const GROUP_PAGE = 25
// 묶지 않은 목록의 한 장.
const FLAT_PAGE = 50
// 보드 컬럼 하나가 그리는 카드 수 — 훑는 화면이라 컬럼 안 페이지네이션 대신, 못 그린 수를 컬럼이 말한다.
const BOARD_PAGE = 20
// 한 화면에 세우는 그룹 수의 상한. 담당자로 묶은 200명짜리 워크스페이스가 200번의 조회가 되지 않도록 막되,
// 잘랐다는 사실은 화면에 남긴다(조용한 상한은 "전부 봤다"로 읽힌다).
const MAX_GROUPS = 20

export type IssueListFilters = IssueViewParams

// The eval tracker's issue list (docs/tracker.md) — "what are we evaluating, and what came back". A regressed
// issue is not untouched work: it carries the resolution it fell from, so it reads as an alarm in every list.
//
// ONE component behind THREE addresses: `/{workspace}/issues` (every team's), `/{workspace}/teams/ENG` and its
// `/issues` twin (that team's), plus `/triage` for a team's inbox. The team is a PATH, not a query parameter —
// a list scoped to a team is a different resource, not the same resource filtered.
//
// The screen is assembled from two sources on purpose: the FILTERS come from the URL (they decide which issues,
// so a pasted link has to reproduce them) and the DISPLAY comes from the reader's cookie, keyed by this list's
// address (it decides only how they are drawn, so a link must not impose it). `entities/issue/model/display.ts`
// carries the full reasoning.
//
// Group COUNTS come from a server aggregate, separately from the rows. That separation is the point: the list
// holds one page per group, so counting the rows it received would just restate the page size instead of
// answering "how many are in progress".
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

  // 이 목록의 좁히기. 행과 그룹 개수가 **같은** 필터를 쓰도록 한 번만 만든다.
  // 사이클 스코프는 URL 의 사이클 필터를 덮어쓴다 — 이 화면은 "그 이터레이션의 보드"이지 "사이클로 좁힌
  // 이슈 목록"이 아니라서, 주소가 이미 답한 것을 필터가 다시 뒤집을 수 있으면 안 된다.
  const scope: IssuePageQuery = {
    ...issueQueryFilters(view),
    ...(team ? { team: team.id } : {}),
    ...(triage ? { triage: true } : {}),
    ...(cycle ? { cycle: [cycle.id] } : {}),
  }

  // 팀 목록은 두 소비자가 있다 — 워크스페이스 전체 목록의 팀 칩(임계 경로)과 「이슈 만들기」의 팀 선택
  // (스트리밍되는 툴바). 호출은 한 번, 기다리는 것은 칩이 실제로 그려지는 화면에서만.
  const teamsPromise = controlPlane
    .listTeams(ctx)
    .then((r) => teamsWithSummarySchema.parse(r))
    .catch((): TeamWithSummary[] => [])

  // 이 읽기들은 서로를 기다릴 이유가 없다 — 순차 await 이면 왕복 시간이 그대로 더해진다. 목록만 실패를
  // 표면에 올리고, 나머지는 자기 자리만 비운다.
  const [counts, teams, projects, cycles, labels, members] = await Promise.all([
    view.grouping === 'none'
      ? Promise.resolve(undefined)
      : controlPlane
          .countIssues(ctx, view.grouping, scope)
          .then((r) => issueGroupCountsSchema.parse(r))
          .catch(() => undefined),
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

  // 그룹별 첫 장. 서버가 그룹마다 자기 페이지를 가져오는 이유는 하나 — 한 장을 받아 화면에서 나누면
  // 헤더의 개수와 그 아래 행이 다른 목록을 말하게 된다(50 건을 받아 7 갈래로 나눈 것은 어느 그룹도 아니다).
  const perGroupLimit = view.layout === 'board' ? BOARD_PAGE : GROUP_PAGE
  const rendered =
    counts === undefined
      ? []
      : orderIssueGroups(issueGroupsToRender(counts.groups, counts.groupBy, view), counts.groupBy)
  const shown = rendered.slice(0, MAX_GROUPS)
  const dropped = rendered.length - shown.length

  const [flat, groupPages] = await Promise.all([
    view.grouping === 'none'
      ? controlPlane
          .listIssues(ctx, {
            ...scope,
            order: view.order,
            limit: FLAT_PAGE,
            ...(filters.cursor ? { cursor: filters.cursor } : {}),
          })
          .then((r) => ({ page: issuePageSchema.parse(r) }))
          .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))
      : Promise.resolve(undefined),
    Promise.all(
      shown.map((group) =>
        // 빈 그룹은 조회하지 않는다 — 보드가 세워 둔 빈 컬럼(끌어다 놓을 자리)이 왕복을 만들면 안 된다.
        group.count === 0
          ? Promise.resolve<IssuePage | undefined>({ items: [] })
          : controlPlane
              .listIssues(ctx, groupQuery(scope, counts?.groupBy, group, view.order, perGroupLimit))
              .then((r) => issuePageSchema.parse(r))
              .catch((): IssuePage | undefined => undefined)
      )
    ),
  ])

  const flatPage = flat !== undefined && 'page' in flat ? flat.page : undefined
  // 집계가 실패하면 묶인 화면은 그릴 근거가 없다 — 「이슈 없음」으로 떨어지면 있는 이슈를 없다고 말하게 된다.
  const error =
    flat !== undefined && 'error' in flat
      ? flat.error
      : view.grouping !== 'none' && counts === undefined
        ? t('countsUnavailable')
        : undefined

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

  const empty =
    view.grouping === 'none' ? (flatPage?.items.length ?? 0) === 0 : (counts?.total ?? 0) === 0

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

      {/* 툴바 — 무엇을 볼 것인가(필터)와 어떻게 볼 것인가(표시). 팀 칩은 워크스페이스 전체 목록에서만, 그리고
          팀이 둘 이상일 때만: 필터가 아니라 그 팀의 목록으로 가는 링크다. */}
      <div className="flex flex-wrap items-center gap-2">
        <IssueFilterMenu
          basePath={basePath}
          view={view}
          directories={directories}
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
          cycles={cycles.map((c) => ({ id: c.id, name: cycleLabel(c) }))}
        />
        <div className="ml-auto flex items-center gap-2">
          {counts !== undefined && (
            <span className="text-[12px] tabular-nums text-muted-foreground">
              {t('totalCount', { count: counts.total })}
            </span>
          )}
          <IssueDisplayMenu viewKey={viewKey} display={display} />
        </div>
      </div>
      {!team && teams.length > 1 && (
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
      )}

      {error ? (
        <Callout tone="danger">{t('loadError', { error })}</Callout>
      ) : empty ? (
        <EmptyState
          icon={<CircleDot strokeWidth={1.75} />}
          title={cycle ? t('cycleEmptyTitle') : triage ? t('triageEmptyTitle') : t('emptyTitle')}
          hint={cycle ? t('cycleEmptyHint') : triage ? t('triageEmptyHint') : t('emptyHint')}
        />
      ) : view.grouping === 'none' ? (
        <div className="space-y-1.5">
          {(flatPage?.items ?? []).map((issue) => (
            <IssueRow
              key={issue.id}
              workspace={workspace}
              issue={issue}
              directories={directories}
              canWrite={canWrite}
              timeZone={timeZone}
            />
          ))}
          {flatPage?.nextCursor !== undefined && (
            <div className="pt-1">
              <Link
                href={pageHref(basePath, filters, flatPage.nextCursor)}
                className="inline-flex items-center rounded-lg border border-border px-3 py-1.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
              >
                {t('loadMore')}
              </Link>
            </div>
          )}
        </div>
      ) : counts !== undefined && view.layout === 'board' ? (
        <IssueBoard
          workspace={workspace}
          groupBy={counts.groupBy}
          columns={shown.map((group, index): IssueBoardColumn => {
            const items = groupPages[index]?.items ?? []
            return {
              key: group.key,
              count: group.count,
              items,
              truncated: groupPages[index]?.nextCursor !== undefined,
            }
          })}
          directories={directories}
          canWrite={canWrite}
        />
      ) : counts !== undefined ? (
        <div className="space-y-3">
          {shown.map((group, index) => (
            <IssueGroup
              key={group.key ?? 'unset'}
              workspace={workspace}
              groupBy={counts.groupBy}
              groupKey={group.key}
              count={group.count}
              initial={groupPages[index]?.items ?? []}
              {...(groupPages[index]?.nextCursor !== undefined
                ? { initialCursor: groupPages[index]?.nextCursor }
                : {})}
              query={{
                ...groupQuery(scope, counts.groupBy, group, view.order, perGroupLimit),
              }}
              directories={directories}
              canWrite={canWrite}
              timeZone={timeZone}
            />
          ))}
        </div>
      ) : null}

      {/* 조용한 상한은 "전부 봤다"로 읽힌다 — 몇 그룹을 안 세웠는지 말한다. */}
      {dropped > 0 && (
        <p className="text-[11.5px] text-muted-foreground">
          {t('groupsTruncated', { count: dropped })}
        </p>
      )}
      {bulkCycles.length > 0 && <IssueBulkBar cycles={bulkCycles} />}
    </div>
  )

  // 고를 대상이 없는 목록(워크스페이스 전체, 읽기 전용)에는 프로바이더를 씌우지 않는다 — 행이 체크박스 자리를
  // 내주지 않고 예전 그대로 그려진다.
  return bulkCycles.length > 0 ? <IssueSelectionProvider>{body}</IssueSelectionProvider> : body
}

// 한 그룹만 고르는 질의 — 목록 전체의 좁히기에 그 그룹의 값을 하나 더 얹는다. 미지정 버킷은 빈 문자열이다
// (쿼리 파라미터에 null 이 없다). 이미 그 축에 필터가 걸려 있어도 여기서 덮어쓴다: 이 요청은 "이 그룹"이지
// "이 그룹 ∩ 사용자가 고른 값들"이 아니고, 그룹 목록 자체가 이미 그 필터를 통과해 나온 것이다.
function groupQuery(
  scope: IssuePageQuery,
  groupBy: string | undefined,
  group: IssueGroupCount,
  order: string,
  limit: number
): IssuePageQuery {
  const value = group.key ?? ''
  const facet =
    groupBy === 'status'
      ? { status: [value] }
      : groupBy === 'priority'
        ? { priority: [value] }
        : groupBy === 'assignee'
          ? { assignee: [value] }
          : groupBy === 'project'
            ? { project: [value] }
            : groupBy === 'cycle'
              ? { cycle: [value] }
              : {}
  return { ...scope, ...facet, order, limit }
}

// 묶지 않은 목록의 다음 장. 보기(필터·정렬)는 그대로 두고 커서만 얹는다.
function pageHref(basePath: string, filters: IssueListFilters, cursor: string): string {
  const q = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (key === 'cursor' || value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) q.append(key, item)
  }
  q.set('cursor', cursor)
  return `${basePath}?${q.toString()}`
}
