'use client'

import { useMemo, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'

import { RunSeriesButton } from '@/features/manage-product'
import { issueHref } from '@/entities/issue'
import { releaseHref, ReleaseStatusBadge, type ProductTimeline } from '@/entities/product'
import { LineChart, seriesColorAt } from '@/shared/ui/charts'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { SectionHeader } from '@/shared/ui/section-header'

import { TimelineFeed } from './timeline-feed'
import { TimelineLanes } from './timeline-lanes'

// The product timeline — it draws the one read the server composed (the web derives nothing).
// One line chart per series: x is that series' batch time, and picking a point goes to that scorecard. Releases and versions are events on
// the SAME axis, so they lie above and below the chart as a strip and a feed — a point with no measurement breaks the line as null (not 0).
export function ProductTimelineView({
  workspace,
  productId,
  timeline,
  canWrite,
  toolbar,
  detailed = false,
}: {
  workspace: string
  productId: string
  timeline: ProductTimeline
  canWrite: boolean
  // Page-owned controls that stand beside the lane title (the range preset) — absent from the home summary.
  toolbar?: ReactNode
  // The event feed, on the detail page only — home is a summary, so it draws only the lanes and the trend.
  detailed?: boolean
}) {
  const t = useTranslations('productPage')
  const locale = useLocale()
  const router = useRouter()

  const dayLabel = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, {
      month: 'numeric',
      day: 'numeric',
      timeZone: 'UTC',
    })
    return (iso: string) => format.format(new Date(iso))
  }, [locale])
  // The hover card's full timestamp — read in the same UTC as the axis ticks (the same rule as the lanes).
  const stamp = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    })
    return (iso: string) => format.format(new Date(iso))
  }, [locale])
  const fmtPct = useMemo(() => {
    const format = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 })
    return (value: number) => format.format(value)
  }, [locale])

  // Release markers: a strip lying above the series charts. A planned release sorts by its target date, a shipped one by its ship time.
  const releaseStrip = [...timeline.releases].sort((a, b) =>
    (a.releasedAt ?? a.targetDate ?? a.createdAt).localeCompare(
      b.releasedAt ?? b.targetDate ?? b.createdAt
    )
  )

  return (
    <div className="space-y-6">
      {/* The proportional time-axis overview — when did what happen (releases, versions, issues). A series' quality trend is answered by the
          chart below. With no event to draw at all the whole section hides (empty-section hiding). */}
      {timeline.releases.length +
        timeline.versions.length +
        timeline.issues.length +
        timeline.capabilities.length >
        0 && (
        <section className="space-y-2.5">
          <SectionHeader title={t('timelineHeading')} action={toolbar} />
          <TimelineLanes workspace={workspace} timeline={timeline} />
        </section>
      )}
      {releaseStrip.length > 0 && (
        <section className="space-y-2.5">
          <SectionHeader title={t('releasesStrip')} />
          <div className="flex flex-wrap items-center gap-2">
            {releaseStrip.map((release) => (
              <Link
                key={release.id}
                href={releaseHref(workspace, release.id)}
                className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs hover:bg-accent"
              >
                <span className="font-[560]">{release.name}</span>
                <ReleaseStatusBadge status={release.status} />
                <span className="text-muted-foreground">
                  {release.releasedAt
                    ? dayLabel(release.releasedAt)
                    : release.targetDate
                      ? t('targetShort', { date: release.targetDate })
                      : null}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {timeline.series.length === 0 ? (
        <EmptyState title={t('noSeriesTitle')} hint={t('noSeriesHint')} />
      ) : (
        timeline.series.map((series, index) => (
          <section key={series.key} className="space-y-2.5">
            <SectionHeader
              title={series.label}
              action={
                <span className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{series.key}</span>
                  {/* Evaluate this series NOW — the place where, back when importing a new version was the only trigger, a declared series
                      produced no point at all until upstream happened to release. */}
                  {canWrite && <RunSeriesButton productId={productId} seriesKey={series.key} />}
                </span>
              }
            />
            <div className="rounded-lg border bg-card p-3.5 shadow-raise">
              {series.points.length === 0 ? (
                // Empty states two facts — "there was no evaluation in this window" and "what makes this run". Without writing the second
                // down, somebody who declared a series and is waiting cannot tell what they are waiting FOR (and on a required
                // series, releases are blocked the whole time).
                <div className="space-y-1.5 py-6 text-center">
                  <p className="text-sm text-muted-foreground">{t('seriesEmpty')}</p>
                  <p className="text-xs text-muted-foreground">{t('seriesEmptyHint')}</p>
                </div>
              ) : (
                <LineChart
                  x={series.points.map((point) => point.createdAt)}
                  series={[{ key: series.key, label: series.label, color: seriesColorAt(index) }]}
                  values={[series.points.map((point) => point.passRate ?? null)]}
                  domain={{ min: 0, max: 1 }}
                  formatValue={fmtPct}
                  formatX={dayLabel}
                  ariaLabel={series.label}
                  emptyLabel={t('seriesEmpty')}
                  onSelect={(columnIndex) => {
                    const point = series.points[columnIndex]
                    if (point) router.push(`/${workspace}/scorecard/${point.scorecardId}`)
                  }}
                  // What one point IS — a pass rate alone cannot answer "why does this point exist". The service version that made this batch
                  // run and the batch's terminal state go on the same card.
                  renderPointDetail={(columnIndex) => {
                    const point = series.points[columnIndex]
                    if (!point) return null
                    return (
                      <div className="mt-1.5 space-y-0.5 border-t pt-1.5 text-[11.5px] text-muted-foreground">
                        <p className="truncate">{stamp(point.createdAt)}</p>
                        {point.serviceVersion && (
                          <p className="truncate font-mono">{point.serviceVersion}</p>
                        )}
                        <p className="truncate">{t('pointStatus', { status: point.status })}</p>
                        <p className="truncate">{t('pointOpen')}</p>
                      </div>
                    )
                  }}
                />
              )}
            </div>
            {/* The versions that made this series run — in the same order as the points, saying what changed to produce each one. */}
            {series.points.some((point) => point.serviceVersion !== undefined) && (
              <p className="text-xs text-muted-foreground">
                {series.points
                  .filter((point) => point.serviceVersion !== undefined)
                  .map((point) => `${dayLabel(point.createdAt)} · ${point.serviceVersion}`)
                  .join('  ·  ')}
              </p>
            )}
          </section>
        ))
      )}

      {/* On the detail page a GitHub-style event feed replaces the issue list — every event on the axis (versions, releases, issues,
          evaluations, contracts) grouped by date and read as one stream. The home summary goes no further than a light issue list. */}
      {detailed ? (
        <TimelineFeed workspace={workspace} timeline={timeline} />
      ) : (
        timeline.issues.length > 0 && (
          <section className="space-y-2.5">
            <SectionHeader title={t('issuesOverlay')} />
            <ul className="space-y-1">
              {timeline.issues.map((issue) => (
                <li key={issue.id} className="flex items-center gap-2 text-sm">
                  <Link
                    href={issueHref(workspace, issue.identifier, issue.title)}
                    className="font-mono text-xs text-muted-foreground hover:text-foreground"
                  >
                    {issue.identifier}
                  </Link>
                  <span className="truncate">{issue.title}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {dayLabel(issue.createdAt)}
                    {issue.resolvedAt ? ` → ${dayLabel(issue.resolvedAt)}` : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )
      )}
    </div>
  )
}
