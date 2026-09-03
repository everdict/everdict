import { Suspense } from 'react'
import { cookies } from 'next/headers'
import { getTimeZone, getTranslations } from 'next-intl/server'

import {
  IssueListBody,
  loadIssueViewData,
  type IssueDirectories,
  type IssueViewBase,
} from '@/features/browse-issues'
import {
  ISSUE_DISPLAY_COOKIE,
  issueDisplayFor,
  WORKSPACE_ISSUES_VIEW_KEY,
  issueViewOf,
  type IssueViewParams,
} from '@/entities/issue'
import { issueLabelDirectoryOf, issueLabelsSchema, type IssueLabel } from '@/entities/issue-label'
import { memberDirectoryOf, membersSchema, type Member } from '@/entities/member'
import { projectsSchema, type Project } from '@/entities/project'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { PageHeader } from '@/shared/ui/page-header'

import { IssueListActions, IssueListActionsSkeleton } from './issue-list-actions'

export type IssueListFilters = IssueViewParams

// The eval tracker's issue list (docs/tracker.md) — "what are we evaluating, and what came back". A regressed
// issue is not untouched work: it carries the resolution it fell from, so it reads as an alarm in every list.
//
// The screen is assembled from two sources on purpose: the FILTERS come from the URL (they decide which issues,
// so a pasted link has to reproduce them) and the DISPLAY comes from the reader's cookie, keyed by this list's
// address (it decides only how they are drawn, so a link must not impose it). `entities/issue/model/display.ts`
// carries the full reasoning.
//
// 서버가 하는 일은 **첫 화면**까지다 — 디렉터리(멤버·프로젝트·라벨)와 목록의 첫 장을 읽어 넘기면,
// 그 뒤로 보기를 바꾸는 것은 전부 `IssueListBody` 가 목록만 새로 받아 처리한다. 그래서 필터 하나를 켜는 데
// 이 페이지 전체가 다시 렌더되지 않는다(그게 "그룹 바꾸면 왜 이렇게 오래 걸리지"의 정체였다).
export async function IssueListView({
  workspace,
  filters,
}: {
  workspace: string
  filters: IssueListFilters
}) {
  const t = await getTranslations('issuesPage')
  const timeZone = await getTimeZone()
  const { principal, ctx } = await currentPrincipal()
  // Which list this is, for the purpose of remembering how it is drawn.
  const viewKey = WORKSPACE_ISSUES_VIEW_KEY
  const display = issueDisplayFor((await cookies()).get(ISSUE_DISPLAY_COOKIE)?.value, viewKey)
  const view = issueViewOf(filters, display)

  // 강제는 제어 평면 몫이고, 여기서는 확실히 403 이 날 버튼을 감춘다.
  const canWrite = can(principal?.roles, 'issues:write')
  // The import picker needs the workspace App's repo list — a github:read (member+) read now that using the
  // integration and configuring it are separate actions, so the entry point follows it instead of the admin-only
  // settings:read it used to borrow. A member keeps the whole sync surface too (bulk pull, per-issue sync,
  // toggles): those ride issues:write and never touch the App configuration.
  const canReadIntegrations = can(principal?.roles ?? [], 'github:read')

  // 주소가 정한 좁히기 — 보기를 바꿔도 변하지 않는 부분이다.
  const base: IssueViewBase = {}

  // 이 읽기들은 서로를 기다릴 이유가 없다 — 순차 await 이면 왕복 시간이 그대로 더해진다. 목록만 실패를
  // 표면에 올리고, 나머지는 자기 자리만 비운다.
  const [data, projects, labels, members] = await Promise.all([
    loadIssueViewData(ctx, { base, view }),
    // Projects power both the filter and the per-row project name; a failure here must not blank the list.
    controlPlane
      .listProjects(ctx, undefined)
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
  ])

  const actors = memberDirectoryOf(members)
  const directories: IssueDirectories = {
    projectName: Object.fromEntries(projects.map((p) => [p.id, p.name])),
    labels: issueLabelDirectoryOf(labels),
    actors,
    members: members.map((m) => ({
      subject: m.subject,
      name: actors[m.subject]?.name ?? m.subject,
      ...(m.avatarUrl !== undefined ? { avatarUrl: m.avatarUrl } : {}),
    })),
  }

  // 이 목록의 주소 — 워크스페이스 전체 목록이다.
  const basePath = `/${workspace}/issues`

  const body = (
    <div className="@container space-y-4">
      <PageHeader
        title={t('title')}
        description={t('description')}
          actions={
            canWrite ? (
              // 버튼 세 개가 GitHub App 설치 상태와 동기화 저장소 목록을 기다린다 — 그 대기를 목록의 임계
              // 경로에서 떼어 자기 경계 뒤로 보낸다.
              <Suspense fallback={<IssueListActionsSkeleton />}>
                <IssueListActions
                  workspace={workspace}
                  projects={projects.map((p) => ({ id: p.id, name: p.name }))}
                  canReadIntegrations={canReadIntegrations}
                />
              </Suspense>
            ) : null
        }
      />

      <IssueListBody
        workspace={workspace}
        basePath={basePath}
        viewKey={viewKey}
        base={base}
        initialView={view}
        initialData={data}
        directories={directories}
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        canWrite={canWrite}
        timeZone={timeZone}
      />
    </div>
  )

  return body
}
