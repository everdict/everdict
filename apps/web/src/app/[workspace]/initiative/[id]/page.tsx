import { ExternalLink } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

import { CommentsSection } from '@/features/discuss'
import {
  initiativeHref,
  InitiativeStatusBadge,
  type InitiativeProjectSummary,
} from '@/entities/initiative'
import { ISSUE_STATUSES, issueHref, IssueStatusIcon } from '@/entities/issue'
import { memberDirectoryOf } from '@/entities/member'
import { PROJECT_STATUSES, type ProjectStatus } from '@/entities/project'
import { TrackerHistory } from '@/entities/tracker-history'
import { cn } from '@/shared/lib/utils'
import { Callout } from '@/shared/ui/callout'
import { DistributionBar } from '@/shared/ui/distribution-bar'
import { Link } from '@/shared/ui/link'
import { Markdown } from '@/shared/ui/markdown'
import { SectionHeader } from '@/shared/ui/section-header'

import { loadInitiative } from './load-initiative'

export const dynamic = 'force-dynamic'

// Overview — what this goal is, and where it is now. The same place as Linear's initiative overview: the description comes first, and
// beneath it **what stage the projects are at** (the status cycle) and issue-level progress answer one row each. What is LEFT comes next,
// and history and discussion last.
export default async function InitiativeOverviewPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('initiativesPage')
  const tracker = await getTranslations('tracker')
  const { initiative, initiatives, members } = await loadInitiative(id)
  // The layout already drew the failure — it is not said twice here.
  if (!initiative) return null

  const current = initiative
  const { readiness } = current
  const children = initiatives.filter((i) => i.parentId === current.id)
  const actors = memberDirectoryOf(members)

  // What stage the projects are at — the "now" of the work under this goal. The status order follows the vocabulary's order (backlog →
  // cancelled), so reading the bar left to right IS the order of progress.
  const projectsByStatus = new Map<ProjectStatus, InitiativeProjectSummary[]>()
  for (const project of readiness.projects) {
    projectsByStatus.set(project.status, [...(projectsByStatus.get(project.status) ?? []), project])
  }
  const projectSegments = PROJECT_STATUSES.map((status) => ({
    label: tracker(`projectStatus.${status}`),
    count: projectsByStatus.get(status)?.length ?? 0,
  })).filter((segment) => segment.count > 0)

  // Issue-level progress — the sum of each project's rollup. The server fills every status key, so there is no empty-value branch.
  const issueSegments = ISSUE_STATUSES.map((status) => ({
    label: tracker(`issueStatus.${status}`),
    count: readiness.projects.reduce((sum, p) => sum + (p.rollup.byStatus[status] ?? 0), 0),
  })).filter((segment) => segment.count > 0)

  return (
    <div className="space-y-7">
      {/* The description starts directly under the name (with no section heading) — the body of this screen IS the goal. It uses the same
          markdown surface as an issue body: writing that DEFINES a goal contains links and lists, and left as plain text "what has to be
          true for this to be reached" becomes one solid paragraph. A ```mermaid fence becoming a diagram is the same as an issue body too —
          there is no reason for writing that sets a goal out as a picture to fall to source only here. */}
      {current.description && <Markdown content={current.description} mermaid />}

      {(projectSegments.length > 0 || issueSegments.length > 0) && (
        <section className="space-y-4">
          <SectionHeader
            title={t('progressTitle')}
            action={
              readiness.projects.length > 0 ? (
                <Link
                  href={initiativeHref(workspace, current.id, 'projects')}
                  className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  {t('seeProjects')}
                </Link>
              ) : null
            }
          />
          {projectSegments.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                {t('projectPhaseTitle')}
              </p>
              <DistributionBar segments={projectSegments} />
            </div>
          )}
          {issueSegments.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                {t('issuePhaseTitle')}
              </p>
              <DistributionBar segments={issueSegments} />
            </div>
          )}
        </section>
      )}

      {/* With no project under the goal there is nothing for progress to count — why it is empty is said here. */}
      {readiness.projects.length === 0 && <Callout tone="info">{t('noProjectsHint')}</Callout>}

      {/* What is left — regressions first (the server sorts it that way). A resolution that broke has to be looked at before new work. */}
      {readiness.blockers.length > 0 && (
        <section className="space-y-3">
          <SectionHeader
            title={t('remainingTitle')}
            action={
              <span className="text-[12px] tabular-nums text-faint">
                {t('remainingCount', { count: readiness.openIssues })}
              </span>
            }
          />
          <div className="space-y-2">
            {readiness.blockers.map((blocker) => (
              <Link
                key={blocker.issueId}
                href={issueHref(workspace, blocker.identifier, blocker.title)}
                className={cn(
                  'flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated',
                  blocker.status === 'regressed' && 'border-destructive/40 bg-destructive/5'
                )}
              >
                <IssueStatusIcon status={blocker.status} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  {blocker.title}
                </span>
                <span className="hidden shrink-0 text-[11px] text-muted-foreground @md:block">
                  {tracker(`issueStatus.${blocker.status}`)}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Resources — where the goal is written down, measured and argued about. An empty section is not drawn (house rule). */}
      {current.resources.length > 0 && (
        <section className="space-y-3">
          <SectionHeader title={t('resourcesTitle')} />
          <div className="space-y-2">
            {current.resources.map((resource) => (
              <a
                key={resource.url}
                href={resource.url}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <ExternalLink className="size-3.5 shrink-0 text-faint" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  {resource.label}
                </span>
                <span className="hidden shrink-0 truncate text-[11.5px] text-muted-foreground @md:block">
                  {new URL(resource.url).hostname}
                </span>
              </a>
            ))}
          </div>
        </section>
      )}

      {/* Sub-goals — a large goal gets split. The parent is carried by the attribute column, so only what is BELOW is counted here. */}
      {children.length > 0 && (
        <section className="space-y-3">
          <SectionHeader title={t('subInitiativesTitle', { count: children.length })} />
          <div className="space-y-2">
            {children.map((child) => (
              <Link
                key={child.id}
                href={initiativeHref(workspace, child.id)}
                className="flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  {child.name}
                </span>
                <InitiativeStatusBadge status={child.status} />
              </Link>
            ))}
          </div>
        </section>
      )}

      {current.history.length > 0 && (
        <section className="space-y-3">
          <SectionHeader title={t('historyTitle')} />
          <TrackerHistory
            kind="initiative"
            subject={tracker('subject.initiative')}
            entries={current.history}
            actors={actors}
            workspace={workspace}
          />
        </section>
      )}

      <CommentsSection
        workspace={workspace}
        resourceType="initiative"
        resourceId={current.id}
        title={t('discussTitle')}
      />
    </div>
  )
}
