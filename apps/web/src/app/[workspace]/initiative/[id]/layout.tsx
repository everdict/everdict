import type { ReactNode } from 'react'
import { ChevronRight, Target } from 'lucide-react'
import { getTimeZone, getTranslations } from 'next-intl/server'

import { InitiativeActions, InitiativeStatusControl } from '@/features/manage-initiative'
import { initiativeHref } from '@/entities/initiative'
import { memberDirectoryOf, memberNameOf } from '@/entities/member'
import { isPastDue } from '@/entities/project'
import { HealthBadge } from '@/entities/tracker-health'
import { can } from '@/shared/auth/can'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { CopyLinkButton } from '@/shared/ui/copy-link-button'
import { Link } from '@/shared/ui/link'
import { PageHeader } from '@/shared/ui/page-header'
import { PropertyList, PropertyRow } from '@/shared/ui/property-list'
import { InfoTip } from '@/shared/ui/tooltip'

import { InitiativeTabs } from './initiative-tabs'
import { loadInitiative } from './load-initiative'

export const dynamic = 'force-dynamic'

// One goal (an Initiative) — "what are we trying to reach, and where are we now". It is not a release unit: completion is a gate because a
// goal with open work left has not been reached, not because anything is being shipped.
//
// The skeleton is its sibling screen's, the project detail, with Linear's tabs on top. ① The breadcrumb (goal list → parent goal) and the
// actions on this goal (copy link, ⋯), ② the name alone and large, ③ the tabs (overview · projects · updates),
// ④ attributes and progress as one right column — those three stay put as tabs change. So you can move around inside without losing
// "what this goal IS".
export default async function InitiativeDetailLayout({
  children,
  params,
}: {
  children: ReactNode
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('initiativesPage')
  const timeZone = await getTimeZone()
  const { initiative, error, roles, initiatives, members } = await loadInitiative(id)

  if (!initiative) {
    return (
      <div className="space-y-5">
        <Link
          href={`/${workspace}/initiatives`}
          className="text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('backToList')}
        </Link>
        <PageHeader title={t('detailFallbackTitle')} />
        <Callout tone="danger">{t('loadError', { error: error ?? '' })}</Callout>
      </div>
    )
  }

  const current = initiative
  const { readiness } = current
  const canWrite = can(roles, 'issues:write')
  const parent = current.parentId ? initiatives.find((i) => i.id === current.parentId) : undefined
  // Being in the planning stage does not make you not late — only a finished or abandoned goal drops out of the due-date judgement.
  const overdue =
    current.status !== 'completed' &&
    current.status !== 'cancelled' &&
    isPastDue(current.targetDate, timeZone)
  const actors = memberDirectoryOf(members)
  // How much has been reached — cancelled work drops out of the denominator (work decided against is not work deferred).
  const scope = readiness.totalIssues
  const done = Math.max(scope - readiness.openIssues, 0)
  const percent = scope === 0 ? 0 : Math.round((done / scope) * 100)

  return (
    <div className="@container">
      {/* ① What this goal hangs from, and what can be done to it. */}
      <div className="flex items-center gap-1 border-b border-border pb-2.5">
        <nav
          aria-label={t('breadcrumbLabel')}
          className="flex min-w-0 items-center gap-1 text-[12.5px]"
        >
          <Link
            href={`/${workspace}/initiatives`}
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('title')}
          </Link>
          {parent && (
            <>
              <ChevronRight className="size-3 shrink-0 text-faint" />
              <Link
                href={initiativeHref(workspace, parent.id)}
                className="truncate text-muted-foreground transition-colors hover:text-foreground"
              >
                {parent.name}
              </Link>
            </>
          )}
        </nav>
        <CopyLinkButton label={t('copyLink')} message={t('linkCopied')} className="ml-0.5" />
        {canWrite && (
          <InitiativeActions
            workspace={workspace}
            initiative={current}
            initiatives={initiatives.map((i) => ({ id: i.id, name: i.name }))}
            members={members.map((m) => ({
              subject: m.subject,
              name: memberNameOf(actors, m.subject),
            }))}
          />
        )}
      </div>

      {/* ② The name is free text a person wrote — it wraps rather than truncates. */}
      <h1 className="flex items-start gap-2 break-words pt-5 text-[22px] font-[560] leading-[1.3] tracking-[-0.01em] text-foreground">
        {/* The icon is a MARK rather than part of the name — the name is what is read, so it is hidden from screen readers. */}
        {current.icon && <span aria-hidden>{current.icon}</span>}
        <span className="min-w-0">{current.name}</span>
      </h1>

      {/* ③ Three questions about the same goal — what is it and where is it / what stage is the work beneath it at / what did the lead say. */}
      <div className="pt-4">
        <InitiativeTabs workspace={workspace} id={current.id} />
      </div>

      <div className="grid gap-x-8 gap-y-6 pt-5 @3xl:grid-cols-[minmax(0,1fr)_17rem]">
        {/* ④ Attributes and progress. When narrow it folds directly under the tabs, so a bottom border separates it from the body. */}
        <aside className="min-w-0 space-y-3.5 border-b border-border pb-6 @3xl:col-start-2 @3xl:row-start-1 @3xl:self-start @3xl:border-b-0 @3xl:pb-0">
          <PropertyList>
            <PropertyRow label={t('fieldStatus')}>
              <InitiativeStatusControl
                id={current.id}
                status={current.status}
                canWrite={canWrite}
              />
            </PropertyRow>
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
            {parent && (
              <PropertyRow label={t('nestingParent')}>
                <Link
                  href={initiativeHref(workspace, parent.id)}
                  className="inline-flex min-w-0 items-center gap-1.5 transition-colors hover:text-foreground"
                >
                  <Target className="size-3.5 shrink-0 text-faint" />
                  <span className="truncate">{parent.name}</span>
                </Link>
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

          {/* Progress is a JUDGEMENT rather than an attribute, so it drops below a divider. A single bar answers "how far along", and
              the numbers beneath it say what is left. */}
          <div className="space-y-2.5 border-t border-border pt-3.5">
            <div className="flex items-center justify-between gap-2">
              <p className="inline-flex items-center gap-1 text-[11px] font-[510] uppercase tracking-wide text-faint">
                {t('progressTitle')}
                <InfoTip content={t('progressTip')} />
              </p>
              <span className="text-[12px] tabular-nums text-muted-foreground">{percent}%</span>
            </div>
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-muted/40"
              role="img"
              aria-label={t('progressDone', { done, total: scope })}
            >
              <div
                className="h-full rounded-full bg-[var(--color-success)]"
                style={{ width: `${percent}%` }}
              />
            </div>
            <PropertyList>
              <PropertyRow label={t('progressOpen')}>
                <span className={cn('tabular-nums', readiness.openIssues > 0 && 'text-foreground')}>
                  {readiness.openIssues}
                </span>
              </PropertyRow>
              <PropertyRow label={t('progressTotal')}>
                <span className="tabular-nums">{readiness.totalIssues}</span>
              </PropertyRow>
              <PropertyRow label={t('progressProjects')}>
                <span className="tabular-nums">{readiness.projects.length}</span>
              </PropertyRow>
            </PropertyList>
          </div>
        </aside>

        {/* The body the tabs draw. */}
        <div className="min-w-0 @3xl:col-start-1 @3xl:row-start-1">{children}</div>
      </div>
    </div>
  )
}
