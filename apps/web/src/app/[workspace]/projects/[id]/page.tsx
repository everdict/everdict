import Link from 'next/link'
import { CalendarClock, ChevronLeft, Clock, Rocket } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { CommentsSection } from '@/features/discuss'
import { ProjectActions, ProjectStatusControl } from '@/features/manage-project'
import { initiativesSchema, type Initiative } from '@/entities/initiative'
import {
  ISSUE_STATUSES,
  issueHref,
  issuesSchema,
  IssueStatusIcon,
  type Issue,
} from '@/entities/issue'
import { membersSchema } from '@/entities/member'
import { isPastDue, projectDetailSchema, type ProjectDetail } from '@/entities/project'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { DistributionBar } from '@/shared/ui/distribution-bar'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { StatCard } from '@/shared/ui/stat-card'
import { InfoTip } from '@/shared/ui/tooltip'

export const dynamic = 'force-dynamic'

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

  const issues: Issue[] = await controlPlane
    .listIssues(ctx, { project: id })
    .then((r) => issuesSchema.parse(r))
    .catch(() => [])
  const initiatives: Initiative[] = await controlPlane
    .listInitiatives(ctx)
    .then((r) => initiativesSchema.parse(r))
    .catch(() => [])
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])

  const canWrite = can(principal?.roles ?? [], 'issues:write')
  const initiative = current.initiativeId
    ? initiatives.find((i) => i.id === current.initiativeId)
    : undefined
  const overdue =
    current.status !== 'completed' &&
    current.status !== 'cancelled' &&
    isPastDue(current.targetDate, timeZone)
  const displayName = (subject: string): string => {
    const m = members.find((x) => x.subject === subject)
    return m?.name ?? m?.email?.split('@')[0] ?? fmtSubject(subject)
  }

  const segments = ISSUE_STATUSES.map((status) => ({
    label: tracker(`issueStatus.${status}`),
    count: current.rollup.byStatus[status] ?? 0,
  })).filter((s) => s.count > 0)

  const grouped = ISSUE_STATUSES.map((status) => ({
    status,
    items: issues.filter((issue) => issue.status === status),
  })).filter((g) => g.items.length > 0)

  const history = [...current.history].reverse()

  return (
    <div className="@container space-y-7">
      <div className="space-y-3">
        <BackLink workspace={workspace} label={t('backToList')} />
        <PageHeader
          title={current.name}
          description={current.description}
          actions={
            <div className="flex items-center gap-2">
              <ProjectStatusControl id={current.id} status={current.status} canWrite={canWrite} />
              {canWrite && (
                <ProjectActions
                  workspace={workspace}
                  project={current}
                  initiatives={initiatives.map((i) => ({ id: i.id, name: i.name }))}
                />
              )}
            </div>
          }
        />
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-muted-foreground">
          {initiative && (
            <Link
              href={`/${workspace}/initiatives/${encodeURIComponent(initiative.id)}`}
              className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
            >
              <Rocket className="size-3.5 text-faint" />
              {initiative.name}
            </Link>
          )}
          {current.targetDate && (
            <span
              className={cn(
                'inline-flex items-center gap-1.5',
                overdue && 'font-[560] text-destructive'
              )}
            >
              <CalendarClock className="size-3.5 text-faint" />
              {t('metaTargetDate')} {current.targetDate}
              {overdue ? ` · ${t('overdue')}` : ''}
            </span>
          )}
          {current.completedAt && (
            <span className="inline-flex items-center gap-1.5">
              {t('metaCompleted')} {fmtDateTime(current.completedAt, timeZone)}
            </span>
          )}
          <span
            className="inline-flex items-center gap-1.5"
            title={`${t('metaCreated')} ${fmtDateTimeFull(current.createdAt, { timeZone })}`}
          >
            <Clock className="size-3.5 text-faint" />
            {t('metaCreated')} {fmtDateTime(current.createdAt, timeZone)}
          </span>
        </div>
      </Card>

      <section className="space-y-3">
        <SectionHeader
          title={t('rollupTitle')}
          action={current.rollup.ready ? <Badge tone="success">{t('rollupReady')}</Badge> : null}
        />
        <div className="grid gap-3 @md:grid-cols-2 @2xl:grid-cols-4">
          <StatCard label={t('rollupTotal')} value={current.rollup.total} />
          <StatCard
            label={t('rollupOpen')}
            value={current.rollup.open}
            tone={current.rollup.open > 0 ? 'danger' : 'default'}
          />
          <StatCard label={t('rollupDone')} value={current.rollup.done} tone="success" />
          <StatCard
            label={
              <span className="inline-flex items-center gap-1">
                {t('rollupEvaluated')}
                <InfoTip content={t('rollupEvaluatedTip')} />
              </span>
            }
            value={current.rollup.evaluated}
            tone="primary"
          />
        </div>
        {segments.length > 0 && <DistributionBar segments={segments} />}
      </section>

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
                  href={issueHref(workspace, issue.identifier)}
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

      {history.length > 0 && (
        <section className="space-y-3">
          <SectionHeader title={t('historyTitle')} />
          <ol className="space-y-1.5 border-l border-border pl-4">
            {/* 점 중심을 세로선 한가운데에 올린다: pl-4(16px) + 선 두께 절반(0.5px) + 점 반지름(3px) */}
            {history.map((entry, i) => (
              <li
                key={`${entry.at}-${i}`}
                className="relative text-[12.5px] text-muted-foreground before:absolute before:-left-[19.5px] before:top-1.5 before:size-1.5 before:rounded-full before:bg-border"
              >
                <span className="text-foreground">{tracker(`historyEvent.${entry.event}`)}</span>
                {' · '}
                {displayName(entry.by)}
                {' · '}
                <time title={fmtDateTimeFull(entry.at, { timeZone })}>
                  {fmtDateTime(entry.at, timeZone)}
                </time>
              </li>
            ))}
          </ol>
        </section>
      )}

      <CommentsSection
        workspace={workspace}
        resourceType="project"
        resourceId={current.id}
        title={t('discussTitle')}
      />
    </div>
  )
}
