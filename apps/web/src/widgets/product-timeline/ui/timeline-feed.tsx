'use client'

import { useMemo, useState, type ReactNode } from 'react'
import {
  CalendarClock,
  CheckCircle2,
  CircleDot,
  Gauge,
  Package,
  Rocket,
  Tag,
  type LucideIcon,
} from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import { issueHref, issueLinkHref } from '@/entities/issue'
import { releaseHref, type ProductTimeline } from '@/entities/product'
import { fmtPct } from '@/shared/lib/format'
import { ActivityFeed, ActivityRow, type ActivityTone } from '@/shared/ui/activity-feed'
import { Link } from '@/shared/ui/link'
import { SectionHeader } from '@/shared/ui/section-header'

// GitHub 프로젝트 타임라인 식 사건 피드 — 레인이 "언제쯤 무슨 일이"를 훑게 해 준다면, 이 피드는 같은
// 사건들을 날짜로 묶어 문장으로 읽게 해 준다: 버전 발행 · 릴리즈 출하/목표 · 이슈 열림/닫힘 · 시리즈
// 평가 · 평가 계약(하네스/데이터셋/저지)의 버전 등록. 전부 서버가 합성해 준 타임라인 read 에서만 그린다.
// 날짜·시각은 레인과 같은 UTC 로 읽는다 — 레인의 점이 8/12 인데 피드가 8/13 이라 말하면 어느 쪽도 못 믿는다.

const FEED_INITIAL = 25

interface FeedEvent {
  key: string
  at: string
  icon: LucideIcon
  tone: ActivityTone
  body: ReactNode
}

// 원격 주소(GitHub 릴리즈)는 새 탭의 <a> 로, 우리 화면은 Link 로 — 레인의 버전 점과 같은 규칙.
function linked(href: string, className: string, children: ReactNode): ReactNode {
  return href.startsWith('http') ? (
    <a href={href} target="_blank" rel="noreferrer" className={className}>
      {children}
    </a>
  ) : (
    <Link href={href} className={className}>
      {children}
    </Link>
  )
}

function RefChip({ children, href }: { children: ReactNode; href?: string }) {
  const chip = (
    <code className="inline-flex items-center rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]">
      {children}
    </code>
  )
  return href !== undefined ? linked(href, 'transition-colors hover:text-foreground', chip) : chip
}

function Subject({ children, href }: { children: ReactNode; href?: string }) {
  const name = <span className="font-[560] text-foreground">{children}</span>
  return href !== undefined
    ? linked(href, 'min-w-0 truncate transition-colors hover:text-primary', name)
    : name
}

export function TimelineFeed({
  workspace,
  timeline,
}: {
  workspace: string
  timeline: ProductTimeline
}) {
  const t = useTranslations('productPage')
  const status = useTranslations('productsPage')
  const locale = useLocale()
  const [expanded, setExpanded] = useState(false)

  const dayLabel = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' })
    return (day: string) => format.format(new Date(`${day}T00:00:00.000Z`))
  }, [locale])

  const events = useMemo<FeedEvent[]>(() => {
    const seriesLabelOf = new Map(timeline.series.map((entry) => [entry.key, entry.label]))
    const out: FeedEvent[] = []
    for (const version of timeline.versions) {
      out.push({
        key: `version:${version.id}`,
        at: version.publishedAt,
        icon: Tag,
        tone: 'neutral',
        body: (
          <>
            <Subject {...(version.url !== undefined ? { href: version.url } : {})}>
              {version.service}
            </Subject>
            <span>{t('feed.versionPublished')}</span>
            <RefChip {...(version.url !== undefined ? { href: version.url } : {})}>
              {version.version}
            </RefChip>
            {version.prerelease && (
              <span className="text-[11px] text-[var(--color-warning)]">{t('prerelease')}</span>
            )}
          </>
        ),
      })
    }
    for (const release of timeline.releases) {
      // 출하는 일어난 사건, 계획은 약속한 날짜 — 톤과 동사가 다르다. 취소된 릴리즈는 피드에 서지 않는다:
      // 아무도 향해 가지 않는 날짜는 뉴스가 아니다(레인의 지평선 규칙과 같은 이유).
      if (release.status === 'released' && release.releasedAt !== undefined) {
        out.push({
          key: `release:${release.id}`,
          at: release.releasedAt,
          icon: Rocket,
          tone: 'success',
          body: (
            <>
              <Subject href={releaseHref(workspace, release.id)}>{release.name}</Subject>
              <span>{t('feed.releaseShipped')}</span>
              {(release.components ?? []).map((component) => (
                <RefChip key={component.service}>
                  {component.service} {component.version ?? '—'}
                </RefChip>
              ))}
            </>
          ),
        })
      } else if (release.status === 'planned' && release.targetDate !== undefined) {
        out.push({
          key: `release:${release.id}`,
          at: `${release.targetDate}T00:00:00.000Z`,
          icon: CalendarClock,
          tone: 'info',
          body: (
            <>
              <Subject href={releaseHref(workspace, release.id)}>{release.name}</Subject>
              <span>{t('feed.releasePlanned')}</span>
              <span className="text-[11px]">{status('releaseStatus.planned')}</span>
            </>
          ),
        })
      }
    }
    for (const issue of timeline.issues) {
      const href = issueHref(workspace, issue.identifier, issue.title)
      out.push({
        key: `issue-open:${issue.id}`,
        at: issue.createdAt,
        icon: CircleDot,
        tone: issue.status === 'regressed' ? 'danger' : 'warning',
        body: (
          <>
            <Subject href={href}>{issue.identifier}</Subject>
            <span>{t('feed.issueOpened')}</span>
            <span className="min-w-0 truncate">{issue.title}</span>
          </>
        ),
      })
      if (issue.resolvedAt !== undefined) {
        out.push({
          key: `issue-resolve:${issue.id}`,
          at: issue.resolvedAt,
          icon: CheckCircle2,
          tone: 'success',
          body: (
            <>
              <Subject href={href}>{issue.identifier}</Subject>
              <span>{t('feed.issueResolved')}</span>
              {/* 닫힘이 딛고 선 증거 — "해결됨"을 검증 가능한 주장으로 만드는 배치. */}
              {issue.resolvedByScorecardId !== undefined && (
                <RefChip href={`/${workspace}/scorecard/${issue.resolvedByScorecardId}`}>
                  {t('feed.evidence')}
                </RefChip>
              )}
            </>
          ),
        })
      }
    }
    for (const entry of timeline.series) {
      for (const point of entry.points) {
        out.push({
          key: `eval:${point.scorecardId}`,
          at: point.createdAt,
          icon: Gauge,
          tone: 'neutral',
          body: (
            <>
              <Subject href={`/${workspace}/scorecard/${point.scorecardId}`}>{entry.label}</Subject>
              <span>{t('feed.seriesEvaluated')}</span>
              {point.passRate !== undefined && (
                <span className="tabular-nums text-[11px] text-foreground/85">
                  {fmtPct(point.passRate)}
                </span>
              )}
              {point.serviceVersion !== undefined && <RefChip>{point.serviceVersion}</RefChip>}
            </>
          ),
        })
      }
    }
    for (const capability of timeline.capabilities) {
      out.push({
        key: `capability:${capability.kind}:${capability.id}@${capability.version}`,
        at: capability.registeredAt,
        icon: Package,
        tone: 'info',
        body: (
          <>
            <Subject href={issueLinkHref(workspace, capability.kind, capability.id)}>
              {capability.id}@{capability.version}
            </Subject>
            <span>{t('feed.capabilityRegistered')}</span>
            <span className="text-[11px]">{t(`capabilityKind.${capability.kind}`)}</span>
            {capability.seriesKeys.map((key) => (
              <RefChip key={key}>{seriesLabelOf.get(key) ?? key}</RefChip>
            ))}
          </>
        ),
      })
    }
    return out.sort((a, b) => b.at.localeCompare(a.at))
  }, [timeline, workspace, t, status])

  if (events.length === 0) return null
  const visible = expanded ? events : events.slice(0, FEED_INITIAL)
  const hidden = events.length - visible.length

  // 날짜 헤더 아래로 그 날의 사건들 — 최신 날부터. UTC 달력 날짜라 레인의 눈금과 같은 날을 말한다.
  const days: Array<{ day: string; rows: FeedEvent[] }> = []
  for (const event of visible) {
    const day = event.at.slice(0, 10)
    const bucket = days.at(-1)
    if (bucket !== undefined && bucket.day === day) bucket.rows.push(event)
    else days.push({ day, rows: [event] })
  }

  return (
    <section className="space-y-2.5">
      <SectionHeader title={t('feedHeading')} />
      <div className="space-y-4">
        {days.map(({ day, rows }) => (
          <div key={day} className="space-y-2">
            <p className="text-[11px] font-[560] uppercase tracking-wide text-faint">
              {dayLabel(day)}
            </p>
            <ActivityFeed>
              {rows.map((event) => (
                <ActivityRow
                  key={event.key}
                  icon={event.icon}
                  tone={event.tone}
                  at={event.at}
                  locale={locale}
                  timeZone="UTC"
                >
                  {event.body}
                </ActivityRow>
              ))}
            </ActivityFeed>
          </div>
        ))}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('feedShowMore', { count: hidden })}
        </button>
      )}
    </section>
  )
}
