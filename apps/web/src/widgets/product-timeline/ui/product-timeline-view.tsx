'use client'

import { useMemo } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'

import { releaseHref, type ProductTimeline } from '@/entities/product'
import { ReleaseStatusBadge } from '@/entities/product'
import { issueHref } from '@/entities/issue'
import { LineChart, seriesColorAt } from '@/shared/ui/charts'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { SectionHeader } from '@/shared/ui/section-header'

// 프로덕트 타임라인 — 서버가 합성해 준 한 번의 read 를 그린다(웹은 파생하지 않는다).
// 시리즈마다 선 차트 하나: x 는 그 시리즈의 배치 시각, 점을 고르면 그 스코어카드로 간다. 릴리즈와 버전은
// 같은 축의 사건이라 차트 위아래에 스트립/피드로 눕는다 — 측정이 없던 지점은 null 로 선이 끊긴다(0 이 아니다).
export function ProductTimelineView({
  workspace,
  timeline,
}: {
  workspace: string
  timeline: ProductTimeline
}) {
  const t = useTranslations('productPage')
  const locale = useLocale()
  const router = useRouter()

  const dayLabel = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', timeZone: 'UTC' })
    return (iso: string) => format.format(new Date(iso))
  }, [locale])
  const fmtPct = useMemo(() => {
    const format = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 })
    return (value: number) => format.format(value)
  }, [locale])

  // 릴리즈 마커: 시리즈 차트 위에 눕는 스트립. 계획된 릴리즈는 목표일, 나간 릴리즈는 출하 시각으로 정렬.
  const releaseStrip = [...timeline.releases].sort((a, b) =>
    (a.releasedAt ?? a.targetDate ?? a.createdAt).localeCompare(b.releasedAt ?? b.targetDate ?? b.createdAt)
  )

  return (
    <div className="space-y-6">
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
              action={<span className="font-mono text-xs text-muted-foreground">{series.key}</span>}
            />
            <div className="rounded-lg border bg-card p-3.5 shadow-raise">
              {series.points.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">{t('seriesEmpty')}</p>
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
                />
              )}
            </div>
            {/* 이 시리즈를 돌게 만든 버전들 — 점과 같은 순서로, 무엇이 바뀌어 이 점이 생겼는지를 적는다. */}
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

      {timeline.issues.length > 0 && (
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
      )}
    </div>
  )
}
