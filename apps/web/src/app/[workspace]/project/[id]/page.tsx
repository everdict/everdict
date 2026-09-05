import { ChevronLeft, ChevronRight, Flag } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { CommentsSection } from '@/features/discuss'
import {
  ProjectActions,
  ProjectInitiativeControl,
  ProjectStatusControl,
  ProjectUpdatePanel,
} from '@/features/manage-project'
import { initiativeHref, initiativesSchema, type Initiative } from '@/entities/initiative'
import {
  ISSUE_STATUSES,
  issueHref,
  issuePageSchema,
  IssueStatusIcon,
  type IssueSummary,
} from '@/entities/issue'
import { memberDirectoryOf, memberNameOf, membersSchema } from '@/entities/member'
import {
  isPastDue,
  projectDetailSchema,
  projectUpdatesSchema,
  type ProjectDetail,
  type ProjectUpdate,
} from '@/entities/project'
import { HealthBadge } from '@/entities/tracker-health'
import { TrackerHistory } from '@/entities/tracker-history'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { CopyLinkButton } from '@/shared/ui/copy-link-button'
import { DistributionBar } from '@/shared/ui/distribution-bar'
import { Link } from '@/shared/ui/link'
import { Markdown } from '@/shared/ui/markdown'
import { PageHeader } from '@/shared/ui/page-header'
import { PropertyList, PropertyRow } from '@/shared/ui/property-list'
import { SectionHeader } from '@/shared/ui/section-header'
import { InfoTip } from '@/shared/ui/tooltip'

export const dynamic = 'force-dynamic'

// The cap on issues drawn on the per-status board. A project's real totals are answered by the rollup the server derives, so one page in
// most-recent-activity order is enough for the board — this is not a screen that has to pull the whole list.
const PROJECT_ISSUE_ROWS = 200

function BackLink({ workspace, label }: { workspace: string; label: string }) {
  return (
    <Link
      href={`/${workspace}/projects`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      {label}
    </Link>
  )
}

// One project — "did we finish the evaluation in time". The rollup is derived on this read (never stored), so
// the counts are always live; `evaluated` is the stricter claim than `done`: closed WITH a scorecard.
//
// The layout is taken straight from its sibling screen, the issue detail (app/[workspace]/issues/[id]) — the same skeleton as Linear's project
// view. ① The top breadcrumb (project → initiative) answers "which goal is this project hanging from", with the actions on this project
// (copy link, ⋯) beside it. ② The name stands alone, large. ③ The body (description, issues, history, discussion) is the left column and
// ④ every attribute and the progress are one right column. The space the previous layout wasted disappears here: the full-width card that
// held one meta line and the StatCard grid that spread four single-digit numbers across 1100px both fold into the right attribute column.
export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('projectsPage')
  const tracker = await getTranslations('tracker')
  const timeZone = await getTimeZone()
  const { principal, ctx } = await currentPrincipal()

  let project: ProjectDetail | undefined
  let error: string | undefined
  try {
    project = projectDetailSchema.parse(await controlPlane.getProject(ctx, id))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!project) {
    return (
      <div className="space-y-5">
        <BackLink workspace={workspace} label={t('backToList')} />
        <PageHeader title={t('detailFallbackTitle')} />
        <Callout tone="danger">{t('loadError', { error: error ?? '' })}</Callout>
      </div>
    )
  }
  const current = project

  // Supplementary reads — the detail still renders if any of them fails, so they run together and a failure
  // degrades only its own slot.
  const [issues, initiatives, members, updates] = await Promise.all([
    controlPlane
      // The project detail's per-status board — one project's issues fit in a single page, and the rollup numbers are derived separately by
      // the server (rollup). All that is needed here is the rows to draw.
      .listIssues(ctx, { project: [id], limit: PROJECT_ISSUE_ROWS })
      .then((r) => issuePageSchema.parse(r).items)
      .catch((): IssueSummary[] => []),
    controlPlane
      .listInitiatives(ctx)
      .then((r) => initiativesSchema.parse(r))
      .catch((): Initiative[] => []),
    controlPlane
      .listMembers(ctx)
      .then((r) => membersSchema.parse(r))
      .catch(() => []),
    // The updates posted — the reason the health colour changed is in here.
    controlPlane
      .listProjectUpdates(ctx, id)
      .then((r) => projectUpdatesSchema.parse(r))
      .catch((): ProjectUpdate[] => []),
  ])

  const canWrite = can(principal?.roles ?? [], 'issues:write')
  // A project can sit under several umbrellas. The breadcrumb carries only the FIRST (a path has to be one), and the right attribute column
  // shows all of them.
  const projectInitiatives = current.initiativeIds
    .map((initiativeId) => initiatives.find((i) => i.id === initiativeId))
    .filter((i): i is Initiative => i !== undefined)
  const initiative = projectInitiatives[0]
  const overdue =
    current.status !== 'completed' &&
    current.status !== 'cancelled' &&
    isPastDue(current.targetDate, timeZone)
  const actors = memberDirectoryOf(members)

  const segments = ISSUE_STATUSES.map((status) => ({
    label: tracker(`issueStatus.${status}`),
    count: current.rollup.byStatus[status] ?? 0,
  })).filter((s) => s.count > 0)

  const grouped = ISSUE_STATUSES.map((status) => ({
    status,
    items: issues.filter((issue) => issue.status === status),
  })).filter((g) => g.items.length > 0)

  return (
    <div className="@container">
      {/* ① What this project hangs from, and what can be done to it. */}
      <div className="flex items-center gap-1 border-b border-border pb-2.5">
        <nav
          aria-label={t('breadcrumbLabel')}
          className="flex min-w-0 items-center gap-1 text-[12.5px]"
        >
          <Link
            href={`/${workspace}/projects`}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('title')}
          </Link>
          {initiative && (
            <>
              <ChevronRight className="size-3 shrink-0 text-faint" />
              <Link
                href={initiativeHref(workspace, initiative.id)}
                className="truncate text-muted-foreground transition-colors hover:text-foreground"
              >
                {initiative.name}
              </Link>
            </>
          )}
        </nav>
        <CopyLinkButton label={t('copyLink')} message={t('linkCopied')} className="ml-0.5" />
        {canWrite && (
          <ProjectActions
            workspace={workspace}
            project={current}
            initiatives={initiatives.map((i) => ({ id: i.id, name: i.name }))}
          />
        )}
      </div>

      {/* ② The name is free text a person wrote — it wraps rather than truncates. */}
      <h1 className="break-words pt-5 text-[22px] font-[560] leading-[1.3] tracking-[-0.01em] text-foreground">
        {current.name}
      </h1>

      <div className="grid gap-x-8 gap-y-6 pt-5 @3xl:grid-cols-[minmax(0,1fr)_17rem]">
        {/* ④ Attributes and progress. When narrow it folds directly under the name, so a bottom border separates it from the body. */}
        <aside className="min-w-0 space-y-3.5 border-b border-border pb-6 @3xl:col-start-2 @3xl:row-start-1 @3xl:self-start @3xl:border-b-0 @3xl:pb-0">
          <PropertyList>
            <PropertyRow label={t('fieldStatus')}>
              <ProjectStatusControl id={current.id} status={current.status} canWrite={canWrite} />
            </PropertyRow>
            {/* The goal row stays even when empty — for someone who can write, this row is the only place to assign one.
                For a read-only viewer the control returns null, so the empty-row hiding convention still holds. */}
            {(canWrite || projectInitiatives.length > 0) && (
              <PropertyRow label={t('fieldInitiative')}>
                <ProjectInitiativeControl
                  workspace={workspace}
                  id={current.id}
                  initiativeIds={current.initiativeIds}
                  initiatives={initiatives.map((i) => ({ id: i.id, name: i.name }))}
                  canWrite={canWrite}
                />
              </PropertyRow>
            )}
            {current.health !== undefined && (
              <PropertyRow label={t('fieldHealth')}>
                <HealthBadge health={current.health} />
              </PropertyRow>
            )}
            {current.lead !== undefined && (
              <PropertyRow label={t('fieldLead')}>
                <span className="truncate">{memberNameOf(actors, current.lead)}</span>
              </PropertyRow>
            )}
            {current.memberIds.length > 0 && (
              <PropertyRow label={t('fieldMembers')}>
                <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  {current.memberIds.map((subject) => (
                    <span key={subject} className="truncate">
                      {memberNameOf(actors, subject)}
                    </span>
                  ))}
                </span>
              </PropertyRow>
            )}
            {current.targetDate && (
              <PropertyRow label={t('metaTargetDate')}>
                <span
                  className={cn(
                    'inline-flex flex-wrap items-center gap-1.5',
                    overdue && 'text-destructive'
                  )}
                >
                  <time dateTime={current.targetDate}>{current.targetDate}</time>
                  {overdue && <Badge tone="danger">{t('overdue')}</Badge>}
                </span>
              </PropertyRow>
            )}
            {current.completedAt && (
              <PropertyRow label={t('metaCompleted')}>
                <time
                  dateTime={current.completedAt}
                  title={fmtDateTimeFull(current.completedAt, { timeZone })}
                >
                  {fmtDateTime(current.completedAt, timeZone)}
                </time>
              </PropertyRow>
            )}
            <PropertyRow label={t('metaCreated')}>
              <time
                dateTime={current.createdAt}
                title={fmtDateTimeFull(current.createdAt, { timeZone })}
              >
                {fmtDateTime(current.createdAt, timeZone)}
              </time>
            </PropertyRow>
          </PropertyList>

          {/* Progress is a JUDGEMENT rather than an attribute, so it drops below a divider. The distribution bar already states the per-status
              counts (the legend), so the only numbers left here are the aggregates above it — `evaluated` especially, which is a stronger claim than "closed", stands on its own. */}
          <div className="space-y-2.5 border-t border-border pt-3.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                {t('rollupTitle')}
              </p>
              {current.rollup.ready && <Badge tone="success">{t('rollupReady')}</Badge>}
            </div>
            {segments.length > 0 && <DistributionBar segments={segments} />}
            <PropertyList>
              <PropertyRow label={t('rollupOpen')}>
                <span className={cn('tabular-nums', current.rollup.open > 0 && 'text-destructive')}>
                  {current.rollup.open}
                </span>
              </PropertyRow>
              <PropertyRow label={t('rollupDone')}>
                <span className="tabular-nums">{current.rollup.done}</span>
              </PropertyRow>
              <PropertyRow
                label={
                  <span className="inline-flex items-center gap-1">
                    {t('rollupEvaluated')}
                    <InfoTip content={t('rollupEvaluatedTip')} />
                  </span>
                }
              >
                <span className="tabular-nums">{current.rollup.evaluated}</span>
              </PropertyRow>
            </PropertyList>
          </div>
        </aside>

        {/* ③ What the project is, and what is happening underneath it. */}
        <div className="min-w-0 space-y-7 @3xl:col-start-1 @3xl:row-start-1">
          {/* The description starts directly under the name (with no section heading) — the body of this screen IS the project. */}
          {/* The same markdown surface as a goal's (an initiative's) description — there is no reason for one layer down to read differently.
              Right down to a ```mermaid fence becoming a diagram. */}
          {current.description && <Markdown content={current.description} mermaid />}

          {grouped.length > 0 && (
            <section className="space-y-4">
              <SectionHeader title={t('issuesTitle', { count: issues.length })} />
              {grouped.map((group) => (
                <div key={group.status} className="space-y-2">
                  <p className="text-[11px] font-[510] uppercase tracking-wide text-faint">
                    {tracker(`issueStatus.${group.status}`)} · {group.items.length}
                  </p>
                  {group.items.map((issue) => (
                    <Link
                      key={issue.id}
                      href={issueHref(workspace, issue.identifier, issue.title)}
                      className={cn(
                        'flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated',
                        issue.status === 'regressed' && 'border-destructive/40 bg-destructive/5'
                      )}
                    >
                      <IssueStatusIcon status={issue.status} />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                        {issue.title}
                      </span>
                      <time className="hidden shrink-0 font-mono text-[11px] text-muted-foreground @md:block">
                        {fmtDateTime(issue.updatedAt, timeZone)}
                      </time>
                    </Link>
                  ))}
                </div>
              ))}
            </section>
          )}

          {/* Milestones — the checkpoints inside a project. Their ORDER is the meaning, so they stand in sortOrder. */}
          {current.milestones.length > 0 && (
            <section className="space-y-3">
              <SectionHeader title={t('milestonesTitle', { count: current.milestones.length })} />
              <div className="space-y-1.5">
                {[...current.milestones]
                  .sort((a, b) => a.sortOrder - b.sortOrder)
                  .map((milestone) => (
                    <div
                      key={milestone.id}
                      className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3 py-2 shadow-raise"
                    >
                      <Flag className="size-3.5 shrink-0 text-faint" />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                        {milestone.name}
                      </span>
                      {milestone.targetDate && (
                        <time className="shrink-0 font-mono text-[11px] text-muted-foreground">
                          {milestone.targetDate}
                        </time>
                      )}
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                        {t('milestoneIssues', {
                          count: issues.filter((issue) => issue.milestoneId === milestone.id)
                            .length,
                        })}
                      </span>
                    </div>
                  ))}
              </div>
            </section>
          )}

          {/* Updates — the only judgement the tracker records. Why the colour changed is left here as a sentence. */}
          <section className="space-y-3">
            <SectionHeader title={t('updatesTitle')} />
            {canWrite && <ProjectUpdatePanel id={current.id} />}
            {updates.length > 0 && (
              <div className="space-y-2">
                {updates.map((update) => (
                  <article key={update.id} className="rounded-lg border bg-card p-3 shadow-raise">
                    <div className="flex flex-wrap items-center gap-2">
                      <HealthBadge health={update.health} />
                      <span className="text-[12px] text-muted-foreground">
                        {memberNameOf(actors, update.createdBy)}
                      </span>
                      <time
                        className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground"
                        dateTime={update.createdAt}
                        title={fmtDateTimeFull(update.createdAt, { timeZone })}
                      >
                        {fmtDateTime(update.createdAt, timeZone)}
                      </time>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
                      {update.body}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </section>

          {current.history.length > 0 && (
            <section className="space-y-3">
              <SectionHeader title={t('historyTitle')} />
              <TrackerHistory
                kind="project"
                subject={tracker('subject.project')}
                entries={current.history}
                actors={actors}
                workspace={workspace}
              />
            </section>
          )}

          <CommentsSection
            workspace={workspace}
            resourceType="project"
            resourceId={current.id}
            title={t('discussTitle')}
          />
        </div>
      </div>
    </div>
  )
}
