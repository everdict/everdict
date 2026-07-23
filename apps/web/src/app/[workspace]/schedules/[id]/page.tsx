import type { ReactNode } from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { getLocale, getTimeZone, getTranslations } from 'next-intl/server'

import { CommentsSection } from '@/features/discuss'
import { ScheduleDetailActions } from '@/features/manage-schedules'
import { ScheduleRuns, type ScheduleRunEntry } from '@/features/schedule-runs'
import { membersSchema } from '@/entities/member'
import { scheduleSchema, type Schedule } from '@/entities/schedule'
import { isTraceEvaluation, scorecardsSchema } from '@/entities/scorecard'
import { can } from '@/shared/auth/can'
import { currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { describeCron, fireDayLabel, fireTimeLabel, nextFires } from '@/shared/lib/cron'
import { fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { UserAvatar } from '@/shared/ui/avatar'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { EntityRef, RuntimeChip } from '@/shared/ui/chip'
import { PageHeader } from '@/shared/ui/page-header'
import { SectionHeader } from '@/shared/ui/section-header'
import { InfoTip } from '@/shared/ui/tooltip'

export const dynamic = 'force-dynamic'

// A schedule's lastStatus is stamped "Auto-disabled: <code> — <message>" when a deterministic (config-class) fire
// failure or a creator-left event paused it. Surface WHY it stopped rather than a bare "paused".
const AUTO_DISABLED_PREFIX = 'Auto-disabled'

export default async function ScheduleDetailPage({
  params,
}: {
  params: Promise<{ workspace: string; id: string }>
}) {
  const { workspace, id } = await params
  const t = await getTranslations('scheduleDetail')
  const locale = await getLocale()
  const timeZone = await getTimeZone()
  const { principal, ctx } = await currentPrincipal()

  let schedule: Schedule | null = null
  try {
    schedule = scheduleSchema.parse(await controlPlane.getSchedule(ctx, id))
  } catch {
    schedule = null // missing / other workspace (404) → back to the list
  }
  if (!schedule) redirect(`/${workspace}/schedules`)

  const canWrite = can(principal?.roles, 'schedules:write')
  const isAdmin = principal?.roles.includes('admin') ?? false
  const me = principal?.subject ?? ''
  const canEdit = me === schedule.createdBy || isAdmin

  // Owner + runner avatars (members join) — supplementary, so the page renders even if it fails.
  const members = await controlPlane
    .listMembers(ctx)
    .then((r) => membersSchema.parse(r))
    .catch(() => [])
  const authors: Record<string, { name: string; avatarUrl?: string }> = {}
  for (const m of members)
    authors[m.subject] = {
      name: m.name ?? m.email?.split('@')[0] ?? m.subject,
      ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
    }
  const ownerName = authors[schedule.createdBy]?.name ?? fmtSubject(schedule.createdBy)

  // Run history — the scorecards this schedule fired (origin.scheduleId), newest first. Supplementary.
  const history = await controlPlane
    .listScorecards(ctx, { schedule: id })
    .then((r) => scorecardsSchema.parse(r))
    .then((list) => [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    .catch(() => [])
  const runEntries: ScheduleRunEntry[] = history.map((s) => {
    const runner = authors[s.createdBy ?? '']
    return {
      id: s.id,
      traceEval: isTraceEvaluation(s),
      metrics: (s.summary ?? []).map((m) => ({
        metric: m.metric,
        mean: m.mean,
        ...(m.passRate != null ? { passRate: m.passRate } : {}),
      })),
      ...(runner ? { runner } : {}),
      createdAt: s.createdAt,
      status: s.status,
    }
  })

  // Next fire: Temporal-authoritative (nextFireTimes) if present, else a cron approximation. Paused → no fire.
  const now = new Date()
  const nowIso = now.toISOString()
  const fires = !schedule.enabled
    ? []
    : schedule.nextFireTimes && schedule.nextFireTimes.length > 0
      ? schedule.nextFireTimes
      : nextFires(schedule.cron, schedule.timezone, now, { count: 6, horizonDays: 60 }).map((d) =>
          d.toISOString()
        )
  const nextFire = fires[0]
  const approx = schedule.enabled && !(schedule.nextFireTimes && schedule.nextFireTimes.length > 0)

  const tmpl = schedule.runTemplate
  const isPull = !!tmpl.pull
  const autoDisabled =
    !schedule.enabled && (schedule.lastStatus?.startsWith(AUTO_DISABLED_PREFIX) ?? false)
  const overlapLabel = t(
    schedule.overlapPolicy === 'bufferOne'
      ? 'overlapBufferOne'
      : schedule.overlapPolicy === 'allowAll'
        ? 'overlapAllowAll'
        : 'overlapSkip'
  )
  const runtimeLabel = tmpl.runtime ?? t('runtimeDefault')
  const runtimeLinkable = !!tmpl.runtime && !tmpl.runtime.startsWith('self:')

  return (
    <div className="space-y-7">
      <div className="space-y-3">
        <Link
          href={`/${workspace}/schedules`}
          className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
          {t('backToList')}
        </Link>
        <PageHeader
          title={schedule.name}
          description={describeCron(schedule.cron, locale)}
          actions={
            <ScheduleDetailActions
              workspace={workspace}
              id={schedule.id}
              enabled={schedule.enabled}
              canWrite={canWrite}
              canEdit={canEdit}
            />
          }
        />

        {/* Meta strip — state · mode · cadence · next fire · overlap · owner. Absent facts aren't rendered. */}
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <Badge tone={schedule.enabled ? 'success' : 'warning'}>
            {schedule.enabled ? t('stateActive') : t('statePaused')}
          </Badge>
          <Badge tone="info">{isPull ? t('modeTrace') : t('modeBatch')}</Badge>
          <span className="font-mono text-faint">{schedule.timezone}</span>
          {schedule.enabled ? (
            nextFire ? (
              <span
                className="text-muted-foreground"
                title={fmtDateTimeFull(nextFire, { timeZone })}
              >
                {t('nextRunLabel')} {fireDayLabel(nextFire, nowIso, schedule.timezone, locale)}{' '}
                {fireTimeLabel(nextFire, schedule.timezone)}
                {approx ? <span className="text-faint"> {t('approxNote')}</span> : null}
              </span>
            ) : (
              <span className="text-faint">{t('nextRunNone')}</span>
            )
          ) : (
            <span className="text-faint">{t('pausedNoFire')}</span>
          )}
          <span className="inline-flex items-center gap-1 text-faint">
            {t('overlapLabel')} {overlapLabel}
            <InfoTip content={t('overlapTip')} />
          </span>
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <UserAvatar
              name={`${ownerName}${schedule.createdBy === me ? ` (${t('meSuffix')})` : ''}`}
              url={authors[schedule.createdBy]?.avatarUrl}
              label={t('ownerLabel')}
            />
            {ownerName}
          </span>
        </div>

        {autoDisabled && (
          <Callout tone="warning" hint={schedule.lastStatus}>
            {t('autoDisabledTitle')}
          </Callout>
        )}
      </div>

      {/* What it runs — the run template. Batch: dataset→harness (+runtime) · judges · knobs. Pull: source · window. */}
      <section className="space-y-2.5">
        <SectionHeader title={t('sectionWhatRuns')} />
        <div className="space-y-2.5 rounded-lg border bg-card px-4 py-3.5 text-[13px] shadow-raise">
          {isPull && tmpl.pull ? (
            <>
              <Row label={t('pullSource')}>
                <code className="font-mono text-[12px]">{tmpl.pull.source}</code>
              </Row>
              {tmpl.pull.scope && (
                <Row label={t('pullScope')}>
                  <code className="font-mono text-[12px]">{tmpl.pull.scope}</code>
                </Row>
              )}
              <Row label={t('pullWindow')}>
                {t('pullWindowValue', { hours: tmpl.pull.windowHours })}
              </Row>
              {tmpl.pull.correlate && <Row label={t('pullCorrelate')}>{tmpl.pull.correlate}</Row>}
            </>
          ) : (
            <>
              <Row label={t('rtDataset')}>
                <Link
                  href={`/${workspace}/datasets/${encodeURIComponent(tmpl.dataset?.id ?? '')}`}
                  className="rounded-sm hover:text-foreground hover:underline"
                >
                  <EntityRef
                    id={tmpl.dataset?.id ?? ''}
                    version={tmpl.dataset?.version}
                    kind="dataset"
                  />
                </Link>
              </Row>
              <Row label={t('rtHarness')}>
                <Link
                  href={`/${workspace}/harnesses/${encodeURIComponent(tmpl.harness?.id ?? '')}`}
                  className="rounded-sm hover:text-foreground hover:underline"
                >
                  <EntityRef
                    id={tmpl.harness?.id ?? ''}
                    version={tmpl.harness?.version}
                    kind="harness"
                  />
                </Link>
              </Row>
              <Row label={t('rtRuntime')}>
                {runtimeLinkable ? (
                  <Link
                    href={`/${workspace}/runtimes/${encodeURIComponent(tmpl.runtime ?? '')}`}
                    className="rounded-sm hover:underline"
                  >
                    <RuntimeChip label={runtimeLabel} />
                  </Link>
                ) : (
                  <RuntimeChip label={runtimeLabel} />
                )}
              </Row>
              {tmpl.concurrency != null && <Row label={t('rtConcurrency')}>{tmpl.concurrency}</Row>}
              {tmpl.trials != null && <Row label={t('rtTrials')}>{tmpl.trials}</Row>}
              {tmpl.cases && (tmpl.cases.limit != null || (tmpl.cases.tags?.length ?? 0) > 0) && (
                <Row label={t('rtSubset')}>
                  <span className="text-muted-foreground">
                    {[
                      tmpl.cases.limit != null ? t('rtSubsetLimit', { n: tmpl.cases.limit }) : null,
                      (tmpl.cases.tags?.length ?? 0) > 0
                        ? t('rtSubsetTags', { tags: (tmpl.cases.tags ?? []).join(', ') })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </Row>
              )}
            </>
          )}
          {tmpl.judges.length > 0 && (
            <Row label={t('rtJudges')}>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {tmpl.judges.map((j) => (
                  <Link
                    key={`${j.id}@${j.version}`}
                    href={`/${workspace}/judges/${encodeURIComponent(j.id)}`}
                    className="rounded-sm hover:text-foreground hover:underline"
                  >
                    <EntityRef id={j.id} version={j.version} kind="judge" />
                  </Link>
                ))}
              </span>
            </Row>
          )}
        </div>
      </section>

      {/* Schedule — raw cron + upcoming fires (next few). */}
      <section className="space-y-2.5">
        <SectionHeader title={t('sectionSchedule')} />
        <div className="space-y-2.5 rounded-lg border bg-card px-4 py-3.5 text-[13px] shadow-raise">
          <Row label={t('cronLabel')}>
            <code className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[12px]">
              {schedule.cron}
            </code>
          </Row>
          <Row label={t('cadenceLabel')}>{describeCron(schedule.cron, locale)}</Row>
          <Row label={t('timezoneLabel')}>
            <code className="font-mono text-[12px]">{schedule.timezone}</code>
          </Row>
          {schedule.enabled && fires.length > 0 && (
            <Row label={t('upcomingLabel')}>
              <div className="space-y-0.5">
                {fires.slice(0, 6).map((iso, i) => (
                  <div
                    key={`${iso}-${i}`}
                    className="font-mono text-[12px] tabular-nums text-muted-foreground"
                    title={fmtDateTimeFull(iso, { timeZone })}
                  >
                    {fireDayLabel(iso, nowIso, schedule.timezone, locale)}{' '}
                    <span className="text-foreground">{fireTimeLabel(iso, schedule.timezone)}</span>
                  </div>
                ))}
              </div>
            </Row>
          )}
        </div>
      </section>

      {/* Run history + trend — the scorecards this schedule fired. Empty → hidden (detail-view convention). */}
      {runEntries.length > 0 && (
        <section className="space-y-2.5">
          <SectionHeader
            title={t('sectionRuns')}
            action={
              <span className="text-[12px] tabular-nums text-faint">
                {t('runsCount', { count: runEntries.length })}
              </span>
            }
          />
          <ScheduleRuns workspace={workspace} entries={runEntries} timeZone={timeZone} />
        </section>
      )}

      <CommentsSection
        workspace={workspace}
        resourceType="schedule"
        resourceId={id}
        title={t('sectionDiscuss')}
      />
    </div>
  )
}

// A label-left / value-right config row (server-safe presentational helper — no hooks).
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="shrink-0 text-[12px] text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right">{children}</span>
    </div>
  )
}
