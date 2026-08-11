'use client'

import { useMemo } from 'react'
import { useLocale, useTranslations } from 'next-intl'

import { issueHref } from '@/entities/issue'
import { releaseHref, type ProductTimeline } from '@/entities/product'
import { cn } from '@/shared/lib/utils'
import { seriesColorAt } from '@/shared/ui/charts'
import { Link } from '@/shared/ui/link'

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
  // 창 밖의 사건도 가장자리에 눌러서 보여 준다 — 사라지는 것보다 낫다. 다만 계획된 릴리즈의 목표일은
  // 서버가 창의 끝(horizon)에 넣어 주므로 여기서 눌릴 일이 없다.
  const pct = (iso: string): number =>
    Math.min(100, Math.max(0, ((Date.parse(iso) - from) / span) * 100))
  // "지금"은 창의 일부다(서버가 준다 — 클라이언트 시계로 그리면 SSR 과 어긋난다). 창이 미래까지 뻗은
  // 경우에만 의미가 있다: 일어난 구간과 예정 구간의 경계선이고, 열린 스팬이 멈추는 지점.
  const nowPct = pct(timeline.window.now)
  const hasFuture = nowPct < 99.5

  const dayLabel = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, {
      month: 'numeric',
      day: 'numeric',
      timeZone: 'UTC',
    })
    return (ms: number) => format.format(new Date(ms))
  }, [locale])

  const services = [...new Set(timeline.versions.map((version) => version.service))]
  const hasReleases = timeline.releases.length > 0
  const hasIssues = timeline.issues.length > 0
  if (!hasReleases && services.length === 0 && !hasIssues) return null

  // 축 눈금 4칸 — 창을 균등 분할한 날짜 라벨.
  const ticks = [0, 1, 2, 3, 4].map((step) => ({
    at: from + (span * step) / 4,
    pct: (step / 4) * 100,
  }))
  const showReleaseNames = timeline.releases.length <= 6

  const lane = 'relative h-8 border-b border-border/50 last:border-b-0'
  const label = 'w-28 shrink-0 truncate pr-2 text-[11px] text-muted-foreground'

  return (
    <div
      className="rounded-lg border bg-card p-3.5 shadow-raise"
      role="img"
      aria-label={t('lanesAria')}
    >
      <div className="relative space-y-0">
        {/* 예정 구간 — "지금"부터 창의 끝(가장 먼 목표일)까지. 계획은 사건이 아니라서 같은 바닥에 그리면
            안 된다: 밴드로 눌러 두고 경계에 오늘 선을 세운다. 레인 행들이 뒤에 오므로(둘 다 positioned)
            마커는 이 밴드 위에 그려진다 — 라벨 폭 w-28 = left-28 이 레인 영역의 왼쪽 끝. */}
        {hasFuture && (
          <div
            className="pointer-events-none absolute inset-y-0 left-28 right-0"
            aria-hidden="true"
          >
            <div
              className="absolute inset-y-0 right-0 bg-muted/50"
              style={{ left: `${nowPct}%` }}
            />
            <div className="absolute inset-y-0 w-px bg-primary/40" style={{ left: `${nowPct}%` }} />
          </div>
        )}
        {hasReleases && (
          <div className="relative flex items-center">
            <span className={label}>{t('laneReleases')}</span>
            <div className={cn(lane, 'flex-1')}>
              {timeline.releases.map((release) => {
                const at = release.releasedAt ?? release.targetDate
                if (at === undefined) return null
                const released = release.status === 'released'
                // 목표일은 달력 날짜(YYYY-MM-DD)라 그 날의 시작으로 읽는다.
                const atPct = pct(at.length === 10 ? `${at}T00:00:00.000Z` : at)
                return (
                  <Link
                    key={release.id}
                    href={releaseHref(workspace, release.id)}
                    // 구성까지 붙인다 — 릴리즈 마커의 질문은 "언제"이고, 바로 다음 질문이 "무엇이 나갔나"다.
                    title={[
                      `${release.name} · ${at.slice(0, 10)}`,
                      ...(release.components ?? []).map(
                        (component) => `${component.service} ${component.version ?? '—'}`
                      ),
                    ].join('\n')}
                    className="group absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
                    style={{ left: `${atPct}%` }}
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
                      // 축 오른쪽 끝의 마커(= 보통 가장 먼 계획)는 이름을 왼쪽에 건다 — 오른쪽에 걸면
                      // 정작 보러 온 그 릴리즈의 이름만 카드 밖으로 잘려 나간다.
                      <span
                        className={cn(
                          'absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-[10px] text-muted-foreground group-hover:text-foreground',
                          atPct > 70 ? 'right-2.5 text-right' : 'left-2.5'
                        )}
                      >
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
          <div key={service} className="relative flex items-center">
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
                    style={{
                      left: `${pct(version.publishedAt)}%`,
                      background: seriesColorAt(index),
                    }}
                  />
                ))}
            </div>
          </div>
        ))}

        {hasIssues && (
          <div className="relative flex items-center">
            <span className={label}>{t('laneIssues')}</span>
            <div className={cn(lane, 'flex-1')}>
              {/* 이슈는 수명이 스팬이다: 생성 → 해결(또는 아직 열려 있으면 오늘까지 — 창의 끝이 아니다.
                  미래로 뻗은 바는 "앞으로도 열려 있을 것"이라는 예언이 되고, 그건 사실이 아니다).
                  해결됨=success, 회귀=danger, 열림=warning — 배지와 같은 시맨틱 토큰만 쓴다.
                  겹침은 위아래 두 트랙으로만 흩는다. */}
              {timeline.issues.map((issue, index) => {
                const start = pct(issue.createdAt)
                // 열린 스팬의 끝은 오늘 — 단, 창 전체가 미래인(호출자가 from 을 미래로 지정한) 퇴화
                // 케이스에서 뒤로 그리지 않게 시작점 아래로는 내려가지 않는다.
                const end =
                  issue.resolvedAt !== undefined ? pct(issue.resolvedAt) : Math.max(start, nowPct)
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
          {ticks.map((tick, index) => {
            // 오늘 라벨과 겹치는 눈금은 뺀다 — 두 날짜가 한 자리에서 서로를 못 읽게 만드는 쪽이 손해다.
            if (hasFuture && Math.abs(tick.pct - nowPct) < 9) return null
            return (
              <span
                key={tick.at}
                className="absolute top-0 font-mono text-[10px] text-faint"
                style={
                  index === 0
                    ? { left: '0%' }
                    : index === ticks.length - 1
                      ? { right: '0%' }
                      : { left: `${tick.pct}%`, transform: 'translateX(-50%)' }
                }
              >
                {dayLabel(tick.at)}
              </span>
            )
          })}
          {/* 오늘 — 창이 미래까지 뻗었을 때만. 축에서 유일하게 강조되는 날짜다. */}
          {hasFuture && (
            <span
              className="absolute top-0 whitespace-nowrap font-mono text-[10px] text-primary"
              style={{ left: `${nowPct}%`, transform: 'translateX(-50%)' }}
            >
              {t('today')}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
