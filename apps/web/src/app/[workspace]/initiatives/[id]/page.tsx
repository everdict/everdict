import Link from 'next/link'
import { CalendarClock, CheckCircle2, ChevronLeft, Clock, ShieldAlert } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { CommentsSection } from '@/features/discuss'
import { InitiativeActions, InitiativeStatusControl } from '@/features/manage-initiative'
import {
  initiativeDetailSchema,
  initiativesSchema,
  type Initiative,
  type InitiativeDetail,
} from '@/entities/initiative'
import { issueHref, IssueStatusIcon } from '@/entities/issue'
import { memberDirectoryOf, membersSchema } from '@/entities/member'
import { isPastDue, ProjectStatusBadge } from '@/entities/project'
import { TrackerHistory } from '@/entities/tracker-history'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { StatCard } from '@/shared/ui/stat-card'
import { InfoTip } from '@/shared/ui/tooltip'

export const dynamic = 'force-dynamic'

function BackLink({ workspace, label }: { workspace: string; label: string }) {
  return (
    <Link
      href={`/${workspace}/initiatives`}
      className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
    >
      <ChevronLeft className="size-3.5" />
      {label}
    </Link>
  )
}

// One initiative — "is everything resolved, can we ship". Readiness counts open issues across every
// NON-CANCELLED project regardless of that project's own status: a project marked completed whose issue later
// regressed still blocks the release. The project status is history; readiness is live truth.
export default async function InitiativeDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('initiativesPage')
  const tracker = await getTranslations('tracker')
  const timeZone = await getTimeZone()
  const { principal, ctx } = await currentPrincipal()

  let initiative: InitiativeDetail | undefined
  let error: string | undefined
  try {
    initiative = initiativeDetailSchema.parse(await controlPlane.getInitiative(ctx, id))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (!initiative) {
    return (
      <div className="space-y-5">
        <BackLink workspace={workspace} label={t('backToList')} />
        <PageHeader title={t('detailFallbackTitle')} />
        <Callout tone="danger">{t('loadError', { error: error ?? '' })}</Callout>
      </div>
    )
  }
  const current = initiative
  const { readiness } = current

  const [members, initiatives] = await Promise.all([
    controlPlane
      .listMembers(ctx)
      .then((r) => membersSchema.parse(r))
      .catch(() => []),
    controlPlane
      .listInitiatives(ctx)
      .then((r) => initiativesSchema.parse(r))
      .catch((): Initiative[] => []),
  ])
  // 이 이니셔티브가 어디에 걸려 있고, 무엇을 품고 있는지. 준비도는 이미 하위까지 합산된 값이므로 여기서는
  // 「어디를 눌러 들어가면 되는지」만 답한다.
  const parent = current.parentId
    ? initiatives.find((i) => i.id === current.parentId)
    : undefined
  const children = initiatives.filter((i) => i.parentId === current.id)
  const initiativeName = new Map(initiatives.map((i) => [i.id, i.name]))
  const canWrite = can(principal?.roles ?? [], 'issues:write')
  const overdue = current.status === 'active' && isPastDue(current.targetDate, timeZone)
  const actors = memberDirectoryOf(members)

  return (
    <div className="@container space-y-7">
      <div className="space-y-3">
        <BackLink workspace={workspace} label={t('backToList')} />
        <PageHeader
          title={current.name}
          description={current.description}
          actions={
            <div className="flex items-center gap-2">
              <InitiativeStatusControl
                id={current.id}
                status={current.status}
                canWrite={canWrite}
              />
              {canWrite && (
                <InitiativeActions
                  workspace={workspace}
                  initiative={current}
                  initiatives={initiatives.map((i) => ({ id: i.id, name: i.name }))}
                />
              )}
            </div>
          }
        />
      </div>

      {/* The readiness card leads — it is the one number a release conversation asks for. */}
      <Card
        className={cn(
          'space-y-4 p-4',
          readiness.ready ? 'border-[var(--color-success)]/30' : 'border-destructive/30'
        )}
      >
        <div className="flex flex-wrap items-center gap-2">
          {readiness.ready ? (
            <CheckCircle2 className="size-5 text-[var(--color-success)]" strokeWidth={1.75} />
          ) : (
            <ShieldAlert className="size-5 text-destructive" strokeWidth={1.75} />
          )}
          <span className="text-[14px] font-[560] text-foreground">
            {readiness.ready ? t('readinessReady') : t('readinessBlocked')}
          </span>
          <InfoTip content={t('readinessTip')} />
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <StatCard
            label={t('readinessOpen')}
            value={readiness.openIssues}
            tone={readiness.openIssues > 0 ? 'danger' : 'success'}
          />
          <StatCard label={t('readinessTotal')} value={readiness.totalIssues} />
          <StatCard label={t('readinessProjects')} value={readiness.projects.length} />
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-muted-foreground">
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

      {/* Blockers — regressions first (the API already sorts them), because a fallen resolution is the one
          thing a release reviewer has to look at before anything else. */}
      {readiness.blockers.length > 0 && (
        <section className="space-y-3">
          <SectionHeader
            title={t('blockersTitle')}
            action={
              <span className="text-[12px] tabular-nums text-faint">
                {t('blockersCount', { count: readiness.blockers.length })}
              </span>
            }
          />
          <div className="space-y-2">
            {readiness.blockers.map((blocker) => (
              <Link
                key={blocker.issueId}
                href={issueHref(workspace, blocker.identifier)}
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

      {(parent !== undefined || children.length > 0) && (
        <section className="space-y-3">
          <SectionHeader title={t('nestingTitle')} />
          <div className="space-y-2">
            {parent && (
              <Link
                href={`/${workspace}/initiatives/${encodeURIComponent(parent.id)}`}
                className="flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <Badge tone="outline">{t('nestingParent')}</Badge>
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  {parent.name}
                </span>
              </Link>
            )}
            {children.map((child) => (
              <Link
                key={child.id}
                href={`/${workspace}/initiatives/${encodeURIComponent(child.id)}`}
                className="flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <Badge tone="neutral">{t('nestingChild')}</Badge>
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                  {child.name}
                </span>
                <span className="hidden shrink-0 text-[11px] text-muted-foreground @md:block">
                  {tracker(`initiativeStatus.${child.status}`)}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {readiness.projects.length > 0 && (
        <section className="space-y-3">
          <SectionHeader title={t('projectsTitle', { count: readiness.projects.length })} />
          <div className="space-y-2">
            {readiness.projects.map((p) => (
              <Link
                key={p.id}
                href={`/${workspace}/projects/${encodeURIComponent(p.id)}`}
                className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <span className="min-w-0 flex-1 truncate text-[13px] font-[510] text-foreground">
                  {p.name}
                  {/* 하위 이니셔티브를 거쳐 올라온 프로젝트는 어디에 걸려 있는지까지 말해야, 막힌 릴리스가
                      우산이 아니라 실제 지점을 가리킨다. */}
                  {p.viaInitiativeId !== undefined && (
                    <span className="ml-2 text-[11.5px] font-normal text-muted-foreground">
                      {initiativeName.get(p.viaInitiativeId) ?? p.viaInitiativeId}
                    </span>
                  )}
                </span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                  {t('projectRollup', {
                    open: p.rollup.open,
                    done: p.rollup.done,
                    total: p.rollup.total,
                  })}
                </span>
                {p.rollup.open > 0 && <Badge tone="danger">{t('projectOpen')}</Badge>}
                {p.targetDate && (
                  <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground @md:block">
                    {p.targetDate}
                  </span>
                )}
                <ProjectStatusBadge status={p.status} />
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
