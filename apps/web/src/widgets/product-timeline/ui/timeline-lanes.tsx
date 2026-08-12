'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { useLocale, useTranslations } from 'next-intl'

import { issueHref } from '@/entities/issue'
import { releaseHref, type ProductTimeline } from '@/entities/product'
import { cn } from '@/shared/lib/utils'
import { seriesColorAt } from '@/shared/ui/charts'
import { Link } from '@/shared/ui/link'

// 비례 시간축 멀티레인 — 릴리즈(마커) · 서비스별 버전(점) · 이슈(발생/해결 마커 + 수명 스팬)를 한 축에 눕힌다.
// SpanWaterfall 의 방식 그대로 %-포지셔닝 div 로 그린다(차트 패밀리는 범주축이라 시간 비례를 못 그린다);
// 색은 시리즈 슬롯(palette)과 시맨틱 토큰에서만 온다. 시리즈의 품질 추이는 아래 패밀리 차트가 답한다 —
// 이 레인들은 "언제 무슨 일이 있었나"만 답한다.
//
// 점 하나하나가 무엇인지는 HOVER 가 답한다. 예전엔 네이티브 `title` 이었는데, 그건 1초쯤 기다려야 뜨고,
// 줄바꿈이 브라우저마다 다르게 렌더되고, 무엇보다 축 위에서 서로 2px 떨어진 점 두 개를 구별하려는
// 사람에게는 없는 것과 같다. 마크와 같은 레이어에 우리가 그리는 카드가 그 질문에 답한다.

interface HoverCard {
  atPct: number
  title: string
  badge?: string
  lines: string[]
  tone?: 'success' | 'warning' | 'danger'
}

export function TimelineLanes({
  workspace,
  timeline,
}: {
  workspace: string
  timeline: ProductTimeline
}) {
  const t = useTranslations('productPage')
  const status = useTranslations('productsPage')
  const locale = useLocale()
  const [hover, setHover] = useState<{ lane: string; card: HoverCard }>()

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
  // 호버 카드의 날짜 — 축 눈금과 같은 UTC 로 읽는다. 카드가 8/13 이라 말하는데 바로 아래 눈금이 8/12 면
  // 둘 중 무엇이 사건의 날짜인지 아무도 답할 수 없다.
  const stamp = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    })
    const day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' })
    return {
      instant: (iso: string) => format.format(new Date(iso)),
      // 달력 날짜(YYYY-MM-DD)는 그 날 전체를 뜻한다 — 시각을 붙이면 없는 정밀도를 주장하게 된다.
      day: (iso: string) => day.format(new Date(`${iso.slice(0, 10)}T00:00:00.000Z`)),
    }
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
  const enter = (laneId: string, card: HoverCard) => ({
    onPointerEnter: () => setHover({ lane: laneId, card }),
    onFocus: () => setHover({ lane: laneId, card }),
  })

  return (
    <div
      className="rounded-lg border bg-card p-3.5 shadow-raise"
      role="group"
      aria-label={t('lanesAria')}
      onPointerLeave={() => setHover(undefined)}
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
                    {...enter('releases', {
                      atPct,
                      title: release.name,
                      badge: status(`releaseStatus.${release.status}`),
                      tone: released ? 'success' : undefined,
                      lines: [
                        release.releasedAt !== undefined
                          ? t('tipReleasedAt', { at: stamp.instant(release.releasedAt) })
                          : t('tipTargetDate', { at: stamp.day(at) }),
                        ...(release.components ?? []).map(
                          (component) => `${component.service} ${component.version ?? '—'}`
                        ),
                      ],
                    })}
                    aria-label={`${release.name} · ${status(`releaseStatus.${release.status}`)}`}
                    className="group absolute top-1/2 -translate-x-1/2 -translate-y-1/2 p-1"
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
                          atPct > 70 ? 'right-3.5 text-right' : 'left-3.5'
                        )}
                      >
                        {release.name}
                      </span>
                    )}
                  </Link>
                )
              })}
              {hover?.lane === 'releases' && <LaneTooltip card={hover.card} />}
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
                .map((version) => {
                  const atPct = pct(version.publishedAt)
                  const mark = (
                    <span
                      className="block size-2 rounded-full transition-transform group-hover:scale-150"
                      style={{ background: seriesColorAt(index) }}
                    />
                  )
                  const hoverProps = enter(`service:${service}`, {
                    atPct,
                    title: `${service} ${version.version}`,
                    badge: version.prerelease ? t('prerelease') : t(`versionKind.${version.kind}`),
                    lines: [
                      t('tipPublishedAt', { at: stamp.instant(version.publishedAt) }),
                      ...(version.url !== undefined ? [t('tipOpenSource')] : []),
                    ],
                  })
                  const position = {
                    className: 'group absolute top-1/2 -translate-x-1/2 -translate-y-1/2 p-1',
                    style: { left: `${atPct}%` },
                    'aria-label': `${service} ${version.version}`,
                  }
                  // 원격에 주소가 있으면 점이 그리로 나가는 문이 된다 — 버전 점을 보고 나서 사람이 하는
                  // 다음 행동은 대체로 "그래서 그 릴리즈에 뭐가 들었지"다.
                  return version.url !== undefined ? (
                    <a
                      key={version.id}
                      href={version.url}
                      target="_blank"
                      rel="noreferrer"
                      {...hoverProps}
                      {...position}
                    >
                      {mark}
                    </a>
                  ) : (
                    <span key={version.id} tabIndex={0} {...hoverProps} {...position}>
                      {mark}
                    </span>
                  )
                })}
              {hover?.lane === `service:${service}` && <LaneTooltip card={hover.card} />}
            </div>
          </div>
        ))}

        {hasIssues && (
          <div className="relative flex items-center">
            <span className={label}>{t('laneIssues')}</span>
            <div className={cn(lane, 'flex-1')}>
              {/* 이슈는 수명이 스팬이지만, 사람이 타임라인에서 찾는 건 두 순간이다: 언제 터졌고 언제
                  끝났나. 그래서 스팬은 배경이 되고 그 위에 발생(◆)과 해결(●) 마커를 따로 세운다 —
                  막대만 있으면 "8월 초에 뭔가 열려 있었다"까지밖에 못 읽는다.
                  해결됨=success, 회귀=danger, 열림=warning — 배지와 같은 시맨틱 토큰만 쓴다.
                  겹침은 위아래 두 트랙으로만 흩는다. */}
              {timeline.issues.map((issue, index) => {
                const start = pct(issue.createdAt)
                // 열린 스팬의 끝은 오늘 — 단, 창 전체가 미래인(호출자가 from 을 미래로 지정한) 퇴화
                // 케이스에서 뒤로 그리지 않게 시작점 아래로는 내려가지 않는다.
                const resolved = issue.resolvedAt !== undefined
                const end =
                  issue.resolvedAt !== undefined ? pct(issue.resolvedAt) : Math.max(start, nowPct)
                const tone =
                  issue.status === 'regressed' ? 'danger' : resolved ? 'success' : 'warning'
                const bar = {
                  danger: 'bg-[var(--color-destructive)]/55',
                  success: 'bg-[var(--color-success)]/45',
                  warning: 'bg-[var(--color-warning)]/55',
                }[tone]
                const ink = {
                  danger: 'border-[var(--color-destructive)] bg-[var(--color-destructive)]',
                  success: 'border-[var(--color-success)] bg-[var(--color-success)]',
                  warning: 'border-[var(--color-warning)] bg-[var(--color-warning)]',
                }[tone]
                const track = index % 2 === 0 ? 'top-[10px]' : 'bottom-[10px]'
                // `moment` 는 지금 가리키고 있는 순간 — 마커일 때만 붙는다. 수명 막대 위에서는 어느
                // 순간도 가리키고 있지 않으므로 배지 없이 이슈 자체를 말한다.
                const card = (atPct: number, moment?: string): HoverCard => ({
                  atPct,
                  title: `${issue.identifier} · ${issue.title}`,
                  ...(moment !== undefined ? { badge: moment } : {}),
                  tone,
                  lines: [
                    t('tipRaisedAt', { at: stamp.instant(issue.createdAt) }),
                    ...(issue.resolvedAt !== undefined
                      ? [t('tipResolvedAt', { at: stamp.instant(issue.resolvedAt) })]
                      : [t('tipStillOpen')]),
                    // 이 이슈가 왜 이 프로덕트의 축에 있는가 — 사람이 건 링크인지, 이 프로덕트의 평가
                    // 증거를 인용/근거로 삼은 것인지. 둘은 다른 주장이라 카드가 그걸 말한다.
                    t(`tipVia.${issue.via}`),
                  ],
                })
                return (
                  <Link
                    key={issue.id}
                    href={issueHref(workspace, issue.identifier, issue.title)}
                    aria-label={`${issue.identifier} · ${issue.title}`}
                    className={cn('absolute', track, 'h-3 -translate-y-1/2')}
                    style={{ left: `${start}%`, width: `${Math.max(1.2, end - start)}%` }}
                  >
                    {/* 수명 — 배경. `evidence` 로 올라온 이슈는 점선 테두리로 눕힌다: 사람이 선언한
                        링크가 아니라 증거에서 유도된 관계라는 사실 자체가 정보다. */}
                    <span
                      {...enter('issues', card((start + end) / 2))}
                      className={cn(
                        'absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full',
                        bar,
                        issue.via === 'evidence' && 'opacity-70'
                      )}
                    />
                    {/* 발생 — 왼쪽 끝의 마름모. */}
                    <span
                      {...enter('issues', card(start, t('momentRaised')))}
                      className={cn(
                        'absolute left-0 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border',
                        ink
                      )}
                    />
                    {/* 해결 — 오른쪽 끝의 원. 아직 열려 있으면 마커가 없다: 끝나지 않은 일에 끝점을
                        찍으면 그건 사실이 아니라 예언이다. */}
                    {resolved && (
                      <span
                        {...enter('issues', card(end, t('momentResolved')))}
                        className={cn(
                          'absolute right-0 top-1/2 size-2 translate-x-1/2 -translate-y-1/2 rounded-full border',
                          ink
                        )}
                      />
                    )}
                  </Link>
                )
              })}
              {hover?.lane === 'issues' && <LaneTooltip card={hover.card} />}
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

// 마크 바로 아래에 뜨는 카드. 축의 양 끝에서는 카드가 잘리므로 정렬을 바꿔 붙인다 — 가장 오른쪽 점은
// 대개 가장 최근 사건이고, 그게 읽히지 않으면 호버의 의미가 없다.
function LaneTooltip({ card }: { card: HoverCard }): ReactNode {
  const nearRight = card.atPct > 70
  const nearLeft = card.atPct < 30
  return (
    <div
      className={cn(
        'pointer-events-none absolute top-[calc(50%+9px)] z-20 w-[230px] rounded-md border bg-popover p-2 text-[12px] shadow-[var(--pop-shadow)]',
        nearRight ? '-translate-x-full' : nearLeft ? 'translate-x-0' : '-translate-x-1/2'
      )}
      style={{ left: `${card.atPct}%` }}
    >
      <div className="flex items-baseline gap-1.5">
        <span className="min-w-0 flex-1 truncate font-[560] text-foreground">{card.title}</span>
        {card.badge && (
          <span
            className={cn(
              'shrink-0 text-[10.5px]',
              card.tone === 'success'
                ? 'text-[var(--color-success)]'
                : card.tone === 'danger'
                  ? 'text-destructive'
                  : card.tone === 'warning'
                    ? 'text-[var(--color-warning)]'
                    : 'text-muted-foreground'
            )}
          >
            {card.badge}
          </span>
        )}
      </div>
      <div className="mt-1 space-y-0.5 text-[11.5px] text-muted-foreground">
        {card.lines.map((line) => (
          <p key={line} className="truncate">
            {line}
          </p>
        ))}
      </div>
    </div>
  )
}
