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
// What the server does ends at the **first screen** — it reads the directories (members, projects, labels) and the list's first page and hands
// them over, and every view change after that is handled by `IssueListBody` fetching only the list. So turning on one filter does not re-render
// this whole page (which is what "why does changing the grouping take so long" actually was).
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

  // Enforcement is the control plane's; here it only hides a button that would certainly 403.
  const canWrite = can(principal?.roles, 'issues:write')
  // The import picker needs the workspace App's repo list — a github:read (member+) read now that using the
  // integration and configuring it are separate actions, so the entry point follows it instead of the admin-only
  // settings:read it used to borrow. A member keeps the whole sync surface too (bulk pull, per-issue sync,
  // toggles): those ride issues:write and never touch the App configuration.
  const canReadIntegrations = can(principal?.roles ?? [], 'github:read')

  // The narrowing the address decides — the part that does not change when the view does.
  const base: IssueViewBase = {}

  // These reads have no reason to wait for each other — awaited in sequence, their round trips simply add up. Only the LIST surfaces a failure;
  // the rest just leave their own slot empty.
  const [data, projects, labels, members] = await Promise.all([
    loadIssueViewData(ctx, { base, view }),
    // Projects power both the filter and the per-row project name; a failure here must not blank the list.
    controlPlane
      .listProjects(ctx, undefined)
      .then((r) => projectsSchema.parse(r))
      .catch((): Project[] => []),
    // A row's label chips need the id→definition join to be drawn. The list still renders on failure (only the chips disappear).
    controlPlane
      .listIssueLabels(ctx)
      .then((r) => issueLabelsSchema.parse(r))
      .catch((): IssueLabel[] => []),
    // An assignee is stored on the issue as a subject alone — drawn as-is it shows a uuid or an internal string like `key:acme`.
    // The name and avatar are attached by the same directory join as the detail page uses (the same join as labels and projects).
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

  // This list's address — the workspace-wide list.
  const basePath = `/${workspace}/issues`

  const body = (
    <div className="@container space-y-4">
      <PageHeader
        title={t('title')}
        description={t('description')}
          actions={
            canWrite ? (
              // Three buttons wait on the GitHub App installation state and the synced-repository list — that wait is taken off the list's
              // critical path and put behind its own boundary.
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
