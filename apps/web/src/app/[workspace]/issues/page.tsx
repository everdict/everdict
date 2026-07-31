import Link from 'next/link'
import { CircleDot } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import {
  ImportGithubIssuesButton,
  PullGithubIssuesButton,
  type SyncedRepository,
} from '@/features/import-github-issues'
import { CreateIssueButton } from '@/features/manage-issue'
import { githubAppViewSchema } from '@/entities/github-app'
import { ISSUE_STATUSES, issuesSchema, IssueStatusIcon, type Issue } from '@/entities/issue'
import { projectsSchema, type Project } from '@/entities/project'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtDateTime } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// The eval tracker's issue list (docs/tracker.md) — "what are we evaluating, and what came back". A regressed
// issue is not untouched work: it carries the resolution it fell from, so it reads as an alarm in every list.
export default async function IssuesPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspace: string }>
  searchParams: Promise<{ status?: string; project?: string }>
}) {
  const { workspace } = await params
  const { status, project } = await searchParams
  const t = await getTranslations('issuesPage')
  const tracker = await getTranslations('tracker')
  const timeZone = await getTimeZone()
  const { principal, ctx } = await currentPrincipal()

  let issues: Issue[] = []
  let error: string | undefined
  try {
    issues = issuesSchema.parse(
      await controlPlane.listIssues(ctx, {
        ...(status ? { status } : {}),
        ...(project ? { project } : {}),
      })
    )
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  // Projects power both the filter and the per-row project name; a failure here must not blank the list.
  const projects: Project[] = await controlPlane
    .listProjects(ctx)
    .then((r) => projectsSchema.parse(r))
    .catch(() => [])
  const projectName = new Map(projects.map((p) => [p.id, p.name]))
  const canWrite = can(principal?.roles ?? [], 'issues:write')

  // The import picker needs the workspace App's repo list, and that read is settings:read (admin) — so the entry
  // point is only offered to someone who can actually complete the flow. A member keeps the whole sync surface
  // (bulk pull, per-issue sync, toggles): those ride issues:write and never touch the App configuration.
  const canReadIntegrations = can(principal?.roles ?? [], 'settings:read')
  const githubConnected =
    canWrite && canReadIntegrations
      ? await controlPlane
          .getGithubApp(ctx)
          .then((r) => githubAppViewSchema.parse(r).installations.length > 0)
          .catch(() => false)
      : false

  // One entry per distinct repo the workspace pulls from — the bulk pull is per repository (one incremental
  // list call each), so the button offers exactly the repos that have something to refresh. The roster is taken
  // from the UNFILTERED set: a status filter narrows what you are looking at, it must not hide a repo you can
  // still refresh.
  const rosterSource: Issue[] =
    status || project
      ? await controlPlane
          .listIssues(ctx)
          .then((r) => issuesSchema.parse(r))
          .catch(() => issues)
      : issues
  const syncedRepositories: SyncedRepository[] = []
  for (const issue of rosterSource) {
    const github = issue.github
    if (!github || !github.sync.pull) continue
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

  function filterHref(next: { status?: string; project?: string }): string {
    const q = new URLSearchParams()
    const nextStatus = 'status' in next ? next.status : status
    const nextProject = 'project' in next ? next.project : project
    if (nextStatus) q.set('status', nextStatus)
    if (nextProject) q.set('project', nextProject)
    const qs = q.toString()
    return `/${workspace}/issues${qs ? `?${qs}` : ''}`
  }

  const chip = (active: boolean) =>
    cn(
      'rounded-full border px-2.5 py-0.5 text-[12px] transition-colors',
      active
        ? 'border-primary/40 bg-primary/10 text-foreground'
        : 'border-border text-muted-foreground hover:text-foreground'
    )

  return (
    <div className="@container space-y-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
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
          title={t('emptyTitle')}
          hint={t('emptyHint')}
        />
      ) : (
        <div className="space-y-2">
          {issues.map((issue) => (
            <Link
              key={issue.id}
              href={`/${workspace}/issues/${encodeURIComponent(issue.id)}`}
              className={cn(
                'group flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated',
                // A regression is the one row that has to catch the eye across the whole list.
                issue.status === 'regressed' && 'border-destructive/40 bg-destructive/5'
              )}
            >
              <IssueStatusIcon status={issue.status} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-[510] text-foreground">{issue.title}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
                  {issue.projectId && (
                    <span className="truncate">
                      {projectName.get(issue.projectId) ?? issue.projectId}
                    </span>
                  )}
                  {issue.assignee && <span className="truncate">{issue.assignee}</span>}
                  {issue.labels.map((label) => (
                    <Badge key={label} tone="outline">
                      {label}
                    </Badge>
                  ))}
                  {issue.links.length > 0 && (
                    <span>{t('rowLinkCount', { count: issue.links.length })}</span>
                  )}
                </p>
              </div>
              <time className="hidden shrink-0 font-mono text-[11px] text-muted-foreground @md:block">
                {fmtDateTime(issue.updatedAt, timeZone)}
              </time>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
