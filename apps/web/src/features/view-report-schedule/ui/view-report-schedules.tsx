import { getLocale, getTranslations } from 'next-intl/server'

import { schedulesSchema, type Schedule } from '@/entities/schedule'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { describeCron } from '@/shared/lib/cron'
import { Badge } from '@/shared/ui/badge'
import { SectionHeader } from '@/shared/ui/section-header'

import { NewReportScheduleDialog } from './new-report-schedule-dialog'
import { ReportScheduleRowActions } from './report-schedule-row-actions'

// The View's report schedules (analysis-studio V3/V4) — "every Monday, report this view's movement". One
// scheduling engine: these ARE ScheduleRecords (runTemplate.report.view === this view), shown in place so a
// member never leaves the view to set up its reporting. An unreachable control plane collapses the section.
export async function ViewReportSchedules({
  viewId,
  canManage,
}: {
  viewId: string
  canManage: boolean
}) {
  const t = await getTranslations('viewReportSchedule')
  const locale = await getLocale()
  let schedules: Schedule[]
  try {
    const ctx = await authContext()
    schedules = schedulesSchema
      .parse(await controlPlane.listSchedules(ctx))
      .filter((s) => s.runTemplate.report?.view === viewId)
  } catch {
    return null
  }

  if (schedules.length === 0 && !canManage) return null

  return (
    <section className="space-y-3">
      <SectionHeader
        title={t('title')}
        action={canManage ? <NewReportScheduleDialog viewId={viewId} /> : undefined}
      />
      {schedules.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('emptyHint')}</p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border bg-card shadow-raise">
          {schedules.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 space-y-0.5">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{s.name}</span>
                  {!s.enabled && <Badge tone="neutral">{t('paused')}</Badge>}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {describeCron(s.cron, locale)}
                  {s.runTemplate.report?.compare === 'previous-period' &&
                    ` · ${t('comparesPrevious')}`}
                  {s.lastStatus && ` · ${t('lastStatus', { status: s.lastStatus })}`}
                </p>
              </div>
              {canManage && (
                <ReportScheduleRowActions schedule={{ id: s.id, enabled: s.enabled }} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
