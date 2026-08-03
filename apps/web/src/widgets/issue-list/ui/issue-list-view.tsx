import Link from 'next/link'
import { CircleDot, MessageSquare } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { TeamScopeBar, type TeamScope } from '@/widgets/team-scope-bar'
import {
  ImportGithubIssuesButton,
  PullGithubIssuesButton,
  type SyncedRepository,
} from '@/features/import-github-issues'
import { CreateIssueButton } from '@/features/manage-issue'
import { githubAppViewSchema } from '@/entities/github-app'
import {
  isOpenIssueStatus,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  issueHref,
  issuePageSchema,
  IssuePriorityIcon,
  IssueStatusIcon,
  type IssueSummary,
} from '@/entities/issue'
import {
  IssueLabelChips,
  issueLabelDirectoryOf,
  issueLabelsSchema,
  type IssueLabel,
} from '@/entities/issue-label'
import {
  memberDirectoryOf,
  memberNameOf,
  membersSchema,
  type Member,
  type MemberDirectory,
} from '@/entities/member'
import { isPastDue, projectsSchema, type Project } from '@/entities/project'
import { teamSectionHref, teamsWithSummarySchema, type TeamWithSummary } from '@/entities/team'
import { can, canInTeam } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtDateTime } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

// 한 화면에 그릴 행 수. 전부 그리던 시절엔 2,000건 워크스페이스에서 HTML 이 6.5 MB 였고 SSR 만 수백 ms 였다 —
// 목록은 훑는 화면이지 통째로 읽는 화면이 아니다. 다음 장은 커서로 잇는다.
const PAGE_SIZE = 50
// 동기화 저장소 목록을 만들기 위한 상한. 저장소 이름을 세는 게 목적이라 한 장이면 충분하다.
const MAX_SYNCED_ROSTER = 200

export interface IssueListFilters {
  status?: string
  project?: string
  priority?: string
  // 다음 장의 불투명 토큰. 필터가 바뀌면 커서는 의미를 잃으므로 filterHref 가 항상 떨군다.
  cursor?: string
}

// 목록 행의 담당자. 이슈는 subject 만 들고 있으므로 워크스페이스 멤버 디렉터리와 한 번 이어 붙여야 사람이
// 된다 — 이슈 상세와 같은 조인, 같은 얼굴. 이미 나간 멤버는 `memberNameOf` 가 축약한 subject 로 떨어진다.
function AssigneeChip({ actors, subject }: { actors: MemberDirectory; subject: string }) {
  const name = memberNameOf(actors, subject)
  const avatarUrl = actors[subject]?.avatarUrl
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <Avatar name={name} size="sm" {...(avatarUrl !== undefined ? { url: avatarUrl } : {})} />
      <span className="truncate">{name}</span>
    </span>
  )
}

// The eval tracker's issue list (docs/tracker.md) — "what are we evaluating, and what came back". A regressed
// issue is not untouched work: it carries the resolution it fell from, so it reads as an alarm in every list.
//
// ONE component behind TWO addresses: `/{workspace}/issues` (every team's) and `/{workspace}/teams/ENG/issues`
// (that team's, plus `/triage` for its inbox). The team is a PATH, not a query parameter — a list scoped to a
// team is a different resource, not the same resource filtered, and each team holds different things. The
// remaining query parameters (status·priority·project·cursor) really are filters over whichever list this is.
export async function IssueListView({
  workspace,
  team,
  triage,
  filters,
}: {
  workspace: string
  // 팀 스코프일 때만. 없으면 워크스페이스 전체 목록이다.
  team?: TeamWithSummary
  // 팀의 트리아지 인박스 — 워크플로 앞에 앉은 큐. 팀 아래에서만 존재한다.
  triage?: boolean
  filters: IssueListFilters
}) {
  const { status, project, priority, cursor } = filters
  const t = await getTranslations('issuesPage')
  const tracker = await getTranslations('tracker')
  const timeZone = await getTimeZone()
  const { principal, ctx } = await currentPrincipal()

  // 쓰기 버튼은 역할 + 팀 두 축을 모두 통과해야 뜬다 — 속하지 않은 팀의 목록에서 「이슈 만들기」를 내밀면
  // 제어 평면이 403 을 줄 게 확실한 버튼을 보여 주는 것이다(강제는 여전히 제어 평면 몫).
  const canWrite = canInTeam(principal, 'issues:write', team?.id)
  // The import picker needs the workspace App's repo list, and that read is settings:read (admin) — so the entry
  // point is only offered to someone who can actually complete the flow. A member keeps the whole sync surface
  // (bulk pull, per-issue sync, toggles): those ride issues:write and never touch the App configuration.
  const canReadIntegrations = can(principal?.roles ?? [], 'settings:read')

  // 이 읽기들은 서로를 기다릴 이유가 없다 — 순차 await 이면 왕복 시간이 그대로 더해진다(측정: 페이지 660ms 중
  // API 직렬 385ms). 목록만 실패를 표면에 올리고, 나머지는 자기 자리만 비운다.
  const [page, teams, projects, labels, members, githubConnected, syncedRoster] = await Promise.all(
    [
      controlPlane
        .listIssues(ctx, {
          ...(status ? { status } : {}),
          // 팀은 경로가 정한다. 슬러그가 아니라 해석된 id 를 보내는 이유는 하나 — 이 값이 목록의 주소이지
          // 사용자가 고른 필터가 아니기 때문이다(제어 평면은 둘 다 받는다).
          ...(team ? { team: team.id } : {}),
          ...(triage ? { triage: true } : {}),
          ...(project ? { project } : {}),
          ...(priority ? { priority } : {}),
          ...(cursor ? { cursor } : {}),
          limit: PAGE_SIZE,
        })
        .then((r) => ({ page: issuePageSchema.parse(r) }))
        .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })),
      // 팀은 워크스페이스 전체 목록의 팀 칩에 쓰인다(칩은 필터가 아니라 그 팀의 목록으로 가는 링크다).
      // 목록이 팀 조회 실패로 비어서는 안 되므로 실패는 빈 목록으로 흡수한다.
      controlPlane
        .listTeams(ctx)
        .then((r) => teamsWithSummarySchema.parse(r))
        .catch((): TeamWithSummary[] => []),
      // Projects power both the filter and the per-row project name; a failure here must not blank the list.
      controlPlane
        .listProjects(ctx, team ? { team: team.id } : undefined)
        .then((r) => projectsSchema.parse(r))
        .catch((): Project[] => []),
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
      canWrite && canReadIntegrations
        ? controlPlane
            .getGithubApp(ctx)
            .then((r) => githubAppViewSchema.parse(r).installations.length > 0)
            .catch(() => false)
        : Promise.resolve(false),
      // The bulk pull is per repository, so the button offers exactly the repos that have something to refresh.
      // The SERVER narrows to the pull-enabled set (`syncPull`) — this used to re-read the entire unfiltered issue
      // list to filter it here, which cost a second full-table read (4 MB) to name a handful of repositories.
      canWrite
        ? controlPlane
            .listIssues(ctx, {
              syncPull: true,
              ...(team ? { team: team.id } : {}),
              limit: MAX_SYNCED_ROSTER,
            })
            .then((r) => issuePageSchema.parse(r).items)
            .catch((): IssueSummary[] => [])
        : Promise.resolve<IssueSummary[]>([]),
    ]
  )

  const issues: IssueSummary[] = 'page' in page ? page.page.items : []
  const nextCursor = 'page' in page ? page.page.nextCursor : undefined
  const error = 'error' in page ? page.error : undefined
  const projectName = new Map(projects.map((p) => [p.id, p.name]))
  const labelDirectory = issueLabelDirectoryOf(labels)
  const actors = memberDirectoryOf(members)

  const syncedRepositories: SyncedRepository[] = []
  for (const issue of syncedRoster) {
    const github = issue.github
    if (!github || !github.pull) continue
    const existing = syncedRepositories.find(
      (r) => r.repository === github.repository && r.host === github.host
    )
    if (existing) existing.issues += 1
    else
      syncedRepositories.push({
        repository: github.repository,
        ...(github.host ? { host: github.host } : {}),
        issues: 1,
      })
  }

  // 이 목록의 주소. 팀 스코프면 팀 아래의 경로 자원이고, 아니면 워크스페이스 전체 목록이다.
  const basePath = team
    ? teamSectionHref(workspace, team.key, triage ? 'triage' : 'issues')
    : `/${workspace}/issues`

  // 커서는 절대 물려주지 않는다 — 3장에서 필터를 바꾸면 그 커서는 다른 목록의 위치라서, 이어붙이면 엉뚱한
  // 구간에서 시작한다. 필터가 바뀌면 언제나 1장부터다. 팀은 여기 없다: 경로가 이미 말하고 있다.
  function filterHref(next: { status?: string; project?: string; priority?: string }): string {
    const q = new URLSearchParams()
    const nextStatus = 'status' in next ? next.status : status
    const nextProject = 'project' in next ? next.project : project
    const nextPriority = 'priority' in next ? next.priority : priority
    if (nextStatus) q.set('status', nextStatus)
    if (nextProject) q.set('project', nextProject)
    if (nextPriority) q.set('priority', nextPriority)
    const qs = q.toString()
    return `${basePath}${qs ? `?${qs}` : ''}`
  }

  // 같은 필터의 다음 장. 커서 페이지네이션이라 "이전"은 없다 — 뒤로 가기가 그 역할을 한다.
  function pageHref(token: string): string {
    const base = filterHref({})
    return `${base}${base.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(token)}`
  }

  const chip = (active: boolean) =>
    cn(
      'rounded-full border px-2.5 py-0.5 text-[12px] transition-colors',
      active
        ? 'border-primary/40 bg-primary/10 text-foreground'
        : 'border-border text-muted-foreground hover:text-foreground'
    )

  const scope: TeamScope | undefined = team
    ? { workspace, team, section: triage ? 'triage' : 'issues' }
    : undefined

  return (
    <div className="@container space-y-6">
      {scope && <TeamScopeBar scope={scope} />}
      <PageHeader
        title={triage ? t('triageTitle') : t('title')}
        description={triage ? t('triageDescription') : t('description')}
        actions={
          canWrite ? (
            <div className="flex flex-wrap items-center gap-2">
              <PullGithubIssuesButton repositories={syncedRepositories} />
              {githubConnected ? (
                <ImportGithubIssuesButton
                  workspace={workspace}
                  projects={projects.map((p) => ({ id: p.id, name: p.name }))}
                />
              ) : (
                // Never a dead import button: with no reachable installation the only useful move is connecting
                // the App, so link there instead of opening a picker that has nothing to show.
                canReadIntegrations && (
                  <Link
                    href={`/${workspace}/settings/integrations`}
                    className="text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {t('connectGithub')}
                  </Link>
                )
              )}
              <CreateIssueButton
                workspace={workspace}
                projects={projects.map((p) => ({ id: p.id, name: p.name }))}
                teams={teams.map((x) => ({ id: x.id, key: x.key, name: x.name }))}
                {...(defaultTeamId(team, teams) !== undefined
                  ? { defaultTeamId: defaultTeamId(team, teams) }
                  : {})}
              />
            </div>
          ) : null
        }
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <Link href={filterHref({ status: undefined })} className={chip(!status)}>
          {t('filterAll')}
        </Link>
        {ISSUE_STATUSES.map((s) => (
          <Link key={s} href={filterHref({ status: s })} className={chip(status === s)}>
            {tracker(`issueStatus.${s}`)}
          </Link>
        ))}
        {/* 팀 칩은 워크스페이스 전체 목록에서만, 그리고 팀이 둘 이상일 때만 — 필터가 아니라 그 팀의 목록으로
            가는 링크다(팀마다 가진 것이 다르므로 주소가 달라야 한다). 팀 안에서는 이미 그 팀이라 뜨지 않는다. */}
        {!team && teams.length > 1 && (
          <>
            <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            {teams.map((x) => (
              <Link
                key={x.id}
                href={teamSectionHref(workspace, x.key, 'issues')}
                className={chip(false)}
              >
                <span className="font-mono">{x.key}</span>
              </Link>
            ))}
          </>
        )}
        {/* 우선순위 — 상태와 같은 축의 칩이다. `none` 은 거르는 값으로 의미가 없어(대부분이 여기 있다)
            긴급~낮음만 낸다. */}
        <span className="ml-2 flex flex-wrap items-center gap-1.5 border-l border-border pl-3">
          {ISSUE_PRIORITIES.filter((p) => p !== 'none').map((p) => (
            <Link
              key={p}
              href={filterHref({ priority: priority === p ? undefined : p })}
              className={chip(priority === p)}
            >
              {tracker(`issuePriority.${p}`)}
            </Link>
          ))}
        </span>
        {projects.length > 0 && (
          <span className="ml-2 flex flex-wrap items-center gap-1.5 border-l border-border pl-3">
            <Link href={filterHref({ project: undefined })} className={chip(!project)}>
              {t('filterAllProjects')}
            </Link>
            {projects.map((p) => (
              <Link
                key={p.id}
                href={filterHref({ project: p.id })}
                className={chip(project === p.id)}
              >
                {p.name}
              </Link>
            ))}
          </span>
        )}
      </div>

      {error ? (
        <Callout tone="danger">{t('loadError', { error })}</Callout>
      ) : issues.length === 0 ? (
        <EmptyState
          icon={<CircleDot strokeWidth={1.75} />}
          title={triage ? t('triageEmptyTitle') : t('emptyTitle')}
          hint={triage ? t('triageEmptyHint') : t('emptyHint')}
        />
      ) : (
        <div className="space-y-2">
          {issues.map((issue) => (
            <Link
              key={issue.id}
              href={issueHref(workspace, issue.identifier)}
              className={cn(
                'group flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated',
                // A regression is the one row that has to catch the eye across the whole list.
                issue.status === 'regressed' && 'border-destructive/40 bg-destructive/5'
              )}
            >
              <IssueStatusIcon status={issue.status} />
              <IssuePriorityIcon priority={issue.priority} />
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-baseline gap-2">
                  {/* 사람이 부르는 이름 — `ENG-12`. 팀이 찍어 이슈에 저장된 값이라 팀을 다시 읽지 않는다. */}
                  <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
                    {issue.identifier}
                  </span>
                  <span className="truncate text-[13px] font-[510] text-foreground">
                    {issue.title}
                  </span>
                </p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
                  {issue.projectId && (
                    <span className="truncate">
                      {projectName.get(issue.projectId) ?? issue.projectId}
                    </span>
                  )}
                  {/* 담당자는 사람이다 — subject 문자열이 아니라 상세 페이지와 같은 얼굴·같은 이름으로 그린다. */}
                  {issue.assignee && <AssigneeChip actors={actors} subject={issue.assignee} />}
                  <IssueLabelChips labelIds={issue.labelIds} directory={labelDirectory} />
                  {issue.linkCount > 0 && (
                    <span>{t('rowLinkCount', { count: issue.linkCount })}</span>
                  )}
                  {/* 대화가 있을 때만 — 「댓글 0」은 매일 보면 노이즈다(빈 섹션 숨김과 같은 규칙). */}
                  {issue.commentCount !== undefined && issue.commentCount > 0 && (
                    <span
                      className="inline-flex items-center gap-0.5"
                      title={t('rowCommentCount', { count: issue.commentCount })}
                    >
                      <MessageSquare className="size-3" strokeWidth={1.75} aria-hidden />
                      <span className="tabular-nums">{issue.commentCount}</span>
                    </span>
                  )}
                  {issue.estimate !== undefined && (
                    <span className="font-mono tabular-nums">{issue.estimate}</span>
                  )}
                  {issue.dueDate !== undefined && (
                    <time
                      dateTime={issue.dueDate}
                      className={cn(
                        'font-mono',
                        isOpenIssueStatus(issue.status) &&
                          isPastDue(issue.dueDate, timeZone) &&
                          'text-destructive'
                      )}
                    >
                      {issue.dueDate}
                    </time>
                  )}
                </p>
              </div>
              <time className="hidden shrink-0 font-mono text-[11px] text-muted-foreground @md:block">
                {fmtDateTime(issue.updatedAt, timeZone)}
              </time>
            </Link>
          ))}
          {nextCursor && (
            <div className="pt-1">
              <Link
                href={pageHref(nextCursor)}
                className="inline-flex items-center rounded-lg border border-border px-3 py-1.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
              >
                {t('loadMore')}
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// 새 이슈가 처음 앉을 팀: 팀 목록 안에서 열었으면 그 팀, 아니면 워크스페이스의 기본 팀. 지금 보고 있는 목록에
// 나타나지 않을 곳에 이슈를 만드는 일이 없도록 한다.
function defaultTeamId(
  scoped: TeamWithSummary | undefined,
  teams: TeamWithSummary[]
): string | undefined {
  return scoped?.id ?? teams.find((x) => x.isDefault)?.id
}
