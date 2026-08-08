'use client'

import { useMemo } from 'react'
import { useLocale, useTranslations } from 'next-intl'

import { issueHref } from '@/entities/issue'
import { releaseHref, type ProductTimeline } from '@/entities/product'
import { Link } from '@/shared/ui/link'
import { seriesColorAt } from '@/shared/ui/charts'
import { cn } from '@/shared/lib/utils'

// 비례 시간축 멀티레인 — 릴리즈(마커) · 서비스별 버전(점) · 이슈(수명 스팬)를 한 축에 눕힌다.
// SpanWaterfall 의 방식 그대로 %-포지셔닝 div 로 그린다(차트 패밀리는 범주축이라 시간 비례를 못 그린다);
// 색은 시리즈 슬롯(palette)과 시맨틱 토큰에서만 온다. 시리즈의 품질 추이는 아래 패밀리 차트가 답한다 —
// 이 레인들은 "언제 무슨 일이 있었나"만 답한다.
export function TimelineLanes({
  workspace,
  timeline,
}: {
  workspace: string
  timeline: ProductTimeline
}) {
  const t = useTranslations('productPage')
  const locale = useLocale()

  const from = Date.parse(timeline.window.from)
  const to = Date.parse(timeline.window.to)
  const span = Math.max(1, to - from)
  // 창 밖의 사건(미래의 목표일 등)도 가장자리에 눌러서 보여 준다 — 사라지는 것보다 낫다.
  const pct = (iso: string): number => Math.min(100, Math.max(0, ((Date.parse(iso) - from) / span) * 100))

  const dayLabel = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', timeZone: 'UTC' })
    return (ms: number) => format.format(new Date(ms))
  }, [locale])

  const services = [...new Set(timeline.versions.map((version) => version.service))]
  const hasReleases = timeline.releases.length > 0
  const hasIssues = timeline.issues.length > 0
  if (!hasReleases && services.length === 0 && !hasIssues) return null

  // 축 눈금 4칸 — 창을 균등 분할한 날짜 라벨.
  const ticks = [0, 1, 2, 3, 4].map((step) => from + (span * step) / 4)
  const showReleaseNames = timeline.releases.length <= 6

  const lane = 'relative h-8 border-b border-border/50 last:border-b-0'
  const label = 'w-28 shrink-0 truncate pr-2 text-[11px] text-muted-foreground'

  return (
    <div
      className="rounded-lg border bg-card p-3.5 shadow-raise"
      role="img"
      aria-label={t('lanesAria')}
    >
      <div className="space-y-0">
        {hasReleases && (
          <div className="flex items-center">
            <span className={label}>{t('laneReleases')}</span>
            <div className={cn(lane, 'flex-1')}>
              {timeline.releases.map((release) => {
                const at = release.releasedAt ?? release.targetDate
                if (at === undefined) return null
                const released = release.status === 'released'
                return (
                  <Link
                    key={release.id}
                    href={releaseHref(workspace, release.id)}
                    title={`${release.name} · ${at.slice(0, 10)}`}
                    className="group absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
                    style={{ left: `${pct(at.length === 10 ? `${at}T00:00:00.000Z` : at)}%` }}
                  >
                    <span
                      className={cn(
                        'block size-2.5 rotate-45 border transition-transform group-hover:scale-125',
                        released
                          ? 'border-[var(--color-success)] bg-[var(--color-success)]'
                          : release.status === 'cancelled'
                            ? 'border-border bg-muted'
                            : 'border-primary bg-background'
                      )}
                    />
                    {showReleaseNames && (
                      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 whitespace-nowrap text-[10px] text-muted-foreground group-hover:text-foreground">
                        {release.name}
                      </span>
                    )}
                  </Link>
                )
              })}
            </div>
          </div>
        )}

        {services.map((service, index) => (
          <div key={service} className="flex items-center">
            <span className={label} title={service}>
              {service}
            </span>
            <div className={cn(lane, 'flex-1')}>
              {timeline.versions
                .filter((version) => version.service === service)
                .map((version) => (
                  <span
                    key={version.id}
                    title={`${version.version} · ${version.publishedAt.slice(0, 10)}`}
                    className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                    style={{ left: `${pct(version.publishedAt)}%`, background: seriesColorAt(index) }}
                  />
                ))}
            </div>
          </div>
        ))}

        {hasIssues && (
          <div className="flex items-center">
            <span className={label}>{t('laneIssues')}</span>
            <div className={cn(lane, 'flex-1')}>
              {/* 이슈는 수명이 스팬이다: 생성 → 해결(또는 창 끝까지 열림). 해결됨=success, 회귀=danger,
                  열림=warning — 배지와 같은 시맨틱 토큰만 쓴다. 겹침은 위아래 두 트랙으로만 흩는다. */}
              {timeline.issues.map((issue, index) => {
                const start = pct(issue.createdAt)
                const end = issue.resolvedAt !== undefined ? pct(issue.resolvedAt) : 100
                const tone =
                  issue.status === 'regressed'
                    ? 'bg-[var(--color-destructive)]/60'
                    : issue.resolvedAt !== undefined
                      ? 'bg-[var(--color-success)]/50'
                      : 'bg-[var(--color-warning)]/60'
                return (
                  <Link
                    key={issue.id}
                    href={issueHref(workspace, issue.identifier, issue.title)}
                    title={`${issue.identifier} · ${issue.title}`}
                    className={cn(
                      'absolute h-1.5 rounded-full transition-opacity hover:opacity-100',
                      tone,
                      index % 2 === 0 ? 'top-[9px]' : 'bottom-[9px]'
                    )}
                    style={{ left: `${start}%`, width: `${Math.max(1.2, end - start)}%` }}
                  />
                )
              })}
            </div>
          </div>
        )}
      </div>

      <div className="mt-1.5 flex items-center">
        <span className={label} />
        <div className="relative h-4 flex-1">
          {ticks.map((tick, index) => (
            <span
              key={tick}
              className="absolute top-0 font-mono text-[10px] text-faint"
              style={
                index === 0
                  ? { left: '0%' }
                  : index === ticks.length - 1
                    ? { right: '0%' }
                    : { left: `${(index / (ticks.length - 1)) * 100}%`, transform: 'translateX(-50%)' }
              }
            >
              {dayLabel(tick)}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
