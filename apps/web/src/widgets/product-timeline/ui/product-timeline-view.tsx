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

// 프로덕트 타임라인 — 서버가 합성해 준 한 번의 read 를 그린다(웹은 파생하지 않는다).
// 시리즈마다 선 차트 하나: x 는 그 시리즈의 배치 시각, 점을 고르면 그 스코어카드로 간다. 릴리즈와 버전은
// 같은 축의 사건이라 차트 위아래에 스트립/피드로 눕는다 — 측정이 없던 지점은 null 로 선이 끊긴다(0 이 아니다).
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
  // 레인 제목 옆에 서는 페이지 소유의 컨트롤(기간 프리셋) — 홈 요약에는 없다.
  toolbar?: ReactNode
  // 상세 페이지에서만 켜지는 사건 피드 — 홈은 요약이라 레인과 추이까지만 그린다.
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
  // 호버 카드의 전체 시각 — 축 눈금과 같은 UTC 로 읽는다(레인의 규칙과 동일).
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

  // 릴리즈 마커: 시리즈 차트 위에 눕는 스트립. 계획된 릴리즈는 목표일, 나간 릴리즈는 출하 시각으로 정렬.
  const releaseStrip = [...timeline.releases].sort((a, b) =>
    (a.releasedAt ?? a.targetDate ?? a.createdAt).localeCompare(
      b.releasedAt ?? b.targetDate ?? b.createdAt
    )
  )

  return (
    <div className="space-y-6">
      {/* 비례 시간축 개요 — 언제 무슨 일이 있었나(릴리즈·버전·이슈). 시리즈의 품질 추이는 아래 차트가 답한다.
          그릴 사건이 하나도 없으면 섹션째 숨긴다(빈 섹션 숨김). */}
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
                  {/* 이 시리즈를 지금 평가한다 — 새 버전 임포트만이 유일한 계기이던 시절, 시리즈를 선언해 놓고
                      업스트림이 릴리즈할 때까지 아무 점도 생기지 않던 자리다. */}
                  {canWrite && <RunSeriesButton productId={productId} seriesKey={series.key} />}
                </span>
              }
            />
            <div className="rounded-lg border bg-card p-3.5 shadow-raise">
              {series.points.length === 0 ? (
                // 비어 있음은 두 가지 사실이다 — "이 기간에 평가가 없다"와 "무엇이 이걸 돌리는가". 후자를
                // 적어 두지 않으면 선언만 해 놓고 기다리는 사람이 무엇을 기다리는지 알 수 없다(그리고 필수
                // 시리즈라면 그동안 릴리즈가 막혀 있다).
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
                  // 점 하나가 무엇인지 — 통과율만으로는 "이 점은 왜 생겼나"에 답할 수 없다. 이 배치를
                  // 돌게 만든 서비스 버전과 배치의 종결 상태를 같은 카드에 적는다.
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

      {/* 상세 페이지는 GitHub 식 사건 피드가 이슈 목록을 대체한다 — 축의 모든 사건(버전·릴리즈·이슈·
          평가·계약)이 날짜로 묶여 한 흐름으로 읽힌다. 홈 요약은 가벼운 이슈 목록까지만. */}
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
