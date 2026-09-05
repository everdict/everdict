'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { useLocale, useTranslations } from 'next-intl'

import { issueHref, issueLinkHref } from '@/entities/issue'
import { releaseHref, type ProductTimeline } from '@/entities/product'
import { cn } from '@/shared/lib/utils'
import { seriesColorAt } from '@/shared/ui/charts'
import { Link } from '@/shared/ui/link'

// A proportional time axis with several lanes — releases (markers), per-service versions (dots) and issues (opened/resolved
// markers plus a lifetime span) laid on one axis. Drawn as %-positioned divs exactly the way SpanWaterfall does (the chart
// family has a categorical axis and cannot draw time proportionally); colour comes only from the series slot (palette) and the
// semantic tokens. A series' quality TREND is answered by the family chart below — these lanes answer only "when did what happen".
//
// What each dot IS is answered by HOVER. It used to be the native `title`, which takes about a second to appear, wraps differently
// in every browser and — above all — might as well not exist for someone trying to tell apart two dots 2px apart on the axis.
// A card we draw on the same layer as the marks answers that question instead.

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
  // Events outside the window are pressed against the edge rather than dropped — better than disappearing. A planned release's
  // target date is never pressed here, though, because the server puts it at the window's horizon.
  const pct = (iso: string): number =>
    Math.min(100, Math.max(0, ((Date.parse(iso) - from) / span) * 100))
  // "Now" is part of the window (the server supplies it — drawing from the client clock disagrees with SSR). It means something only
  // when the window reaches into the future: the boundary between what happened and what is scheduled, and where an open span stops.
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
  // The hover card's date — read in the same UTC as the axis ticks. With the card saying 8/13 over a tick saying 8/12, nobody can
  // answer which of the two is the event's date.
  const stamp = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    })
    const day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' })
    return {
      instant: (iso: string) => format.format(new Date(iso)),
      // A calendar date (YYYY-MM-DD) means the whole day — attaching a time claims precision that does not exist.
      day: (iso: string) => day.format(new Date(`${iso.slice(0, 10)}T00:00:00.000Z`)),
    }
  }, [locale])

  const services = [...new Set(timeline.versions.map((version) => version.service))]
  // The capability lane — what the evaluation contract did while the service moved. One lane per kind (harness, dataset, judge),
  // and only when that kind has an event inside the window (the same rule as empty-section hiding).
  const capabilityKinds = (['harness', 'dataset', 'judge'] as const).filter((kind) =>
    timeline.capabilities.some((capability) => capability.kind === kind)
  )
  const seriesLabelOf = new Map(timeline.series.map((entry) => [entry.key, entry.label]))
  const hasReleases = timeline.releases.length > 0
  const hasIssues = timeline.issues.length > 0
  if (!hasReleases && services.length === 0 && !hasIssues && capabilityKinds.length === 0)
    return null

  // Track assignment for issue spans — only OVERLAPPING lifetimes are spread across tracks (greedy interval packing). The old
  // odd/even-by-index assignment only separated neighbours, so three issues opened in one week put the first and third on one track,
  // exactly overlapping. The track count is the real maximum concurrent overlap, so a dense window grows the lane by that much
  // (better than drawing them on top of each other and seeing none).
  const issueSpans = timeline.issues
    .map((issue) => {
      const start = pct(issue.createdAt)
      // An open span ends TODAY — except it never goes below its own start, so a degenerate window that is entirely in the future
      // (a caller passing a future `from`) does not draw backwards.
      const resolved = issue.resolvedAt !== undefined
      const end = issue.resolvedAt !== undefined ? pct(issue.resolvedAt) : Math.max(start, nowPct)
      return { issue, start, end, resolved }
    })
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const trackEnds: number[] = []
  const trackedIssues = issueSpans.map((span) => {
    // Reuse the first free track, leaving room for the opened/resolved markers (roughly ±1% on the axis).
    let track = trackEnds.findIndex((end) => span.start > end + 2)
    if (track === -1) {
      track = trackEnds.length
      trackEnds.push(span.end)
    } else {
      trackEnds[track] = span.end
    }
    return { ...span, track }
  })
  const issueTrackCount = Math.max(1, trackEnds.length)
  // Track pitch 12px with 10px above and below — up to two tracks this is the old lane height (h-8) unchanged.
  const issueLaneHeight = Math.max(32, 20 + (issueTrackCount - 1) * 12)

  // Four axis ticks — date labels dividing the window evenly.
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
        {/* The today line always stands — even when the window ends today, "where is now on this axis" is a question this graph has to
            answer (it stands at the right edge then). Only the scheduled BAND appears when the window reaches into the future: a plan is
            not an event and must not be drawn on the same floor. The lane rows come after it (both positioned), so markers draw above
            this layer — label width w-28 = left-28 is the left edge of the lane area. */}
        <div className="pointer-events-none absolute inset-y-0 left-28 right-0" aria-hidden="true">
          {hasFuture && (
            <div
              className="absolute inset-y-0 right-0 bg-muted/50"
              style={{ left: `${nowPct}%` }}
            />
          )}
          <div className="absolute inset-y-0 w-px bg-primary/40" style={{ left: `${nowPct}%` }} />
        </div>
        {hasReleases && (
          <div className="relative flex items-center">
            <span className={label}>{t('laneReleases')}</span>
            <div className={cn(lane, 'flex-1')}>
              {timeline.releases.map((release) => {
                const at = release.releasedAt ?? release.targetDate
                if (at === undefined) return null
                const released = release.status === 'released'
                // A target date is a calendar date (YYYY-MM-DD), so it is read as the START of that day.
                const atPct = pct(at.length === 10 ? `${at}T00:00:00.000Z` : at)
                return (
                  <Link
                    key={release.id}
                    href={releaseHref(workspace, release.id)}
                    // The composition rides along too — a release marker's question is "when", and the very next one is "what shipped".
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
                      // A marker at the axis' right edge (usually the furthest plan) hangs its name on the LEFT — hung on the right, the
                      // name of the very release you came to read is what gets clipped out of the card.
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
                  // With an address on the remote, the dot becomes the door out to it — after looking at a version dot, the next thing a
                  // person does is usually "so what was in that release".
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

        {capabilityKinds.map((kind) => (
          <div key={kind} className="relative flex items-center">
            <span className={label}>{t(`laneCapability.${kind}`)}</span>
            <div className={cn(lane, 'flex-1')}>
              {timeline.capabilities
                .filter((capability) => capability.kind === kind)
                .map((capability) => {
                  const atPct = pct(capability.registeredAt)
                  const reference = `${capability.id}@${capability.version}`
                  return (
                    // A mark is the door out to the capability's own detail — after seeing "the contract moved", the next question is
                    // "moved to WHAT". The info tone: colour says first that this is an event on a different axis from the series dots
                    // (palette) and releases (primary).
                    <Link
                      key={`${reference}:${capability.registeredAt}`}
                      href={issueLinkHref(workspace, capability.kind, capability.id)}
                      aria-label={reference}
                      {...enter(`capability:${kind}`, {
                        atPct,
                        title: reference,
                        badge: t(`capabilityKind.${capability.kind}`),
                        lines: [
                          t('tipRegisteredAt', { at: stamp.instant(capability.registeredAt) }),
                          // The series watching this capability — on a product with several series, the answer to "whose contract moved".
                          // A series whose label is gone but whose key remains speaks as the bare key.
                          ...(capability.seriesKeys.length > 0
                            ? [
                                t('tipWatchedBy', {
                                  series: capability.seriesKeys
                                    .map((key) => seriesLabelOf.get(key) ?? key)
                                    .join(', '),
                                }),
                              ]
                            : []),
                        ],
                      })}
                      className="group absolute top-1/2 -translate-x-1/2 -translate-y-1/2 p-1"
                      style={{ left: `${atPct}%` }}
                    >
                      <span className="block size-2 rounded-[3px] border border-[var(--color-link)] bg-[var(--color-link)]/25 transition-transform group-hover:scale-125" />
                    </Link>
                  )
                })}
              {hover?.lane === `capability:${kind}` && <LaneTooltip card={hover.card} />}
            </div>
          </div>
        ))}

        {hasIssues && (
          <div className="relative flex items-center">
            <span className={label}>{t('laneIssues')}</span>
            <div className={cn(lane, 'flex-1')} style={{ height: `${issueLaneHeight}px` }}>
              {/* An issue's lifetime is a span, but what a person looks for on a timeline is two MOMENTS: when it broke and when it ended.
                  So the span becomes the background and the opened (◆) and resolved (●) markers stand on top of it — with the bar alone you
                  can read no further than "something was open in early August".
                  resolved=success, regressed=danger, open=warning — only the same semantic tokens the badges use. */}
              {trackedIssues.map(({ issue, start, end, resolved, track }) => {
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
                // `moment` is the instant currently being pointed at — present only on a marker. Over the lifetime bar no instant is being
                // pointed at, so it speaks about the issue itself with no badge.
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
                    // Why this issue is on THIS product's axis — a link a person made, or a relation derived from citing this product's
                    // evaluation evidence. Two different claims, so the card says which.
                    t(`tipVia.${issue.via}`),
                  ],
                })
                return (
                  <Link
                    key={issue.id}
                    href={issueHref(workspace, issue.identifier, issue.title)}
                    aria-label={`${issue.identifier} · ${issue.title}`}
                    className="absolute h-3 -translate-y-1/2"
                    style={{
                      left: `${start}%`,
                      width: `${Math.max(1.2, end - start)}%`,
                      top: `${10 + track * 12}px`,
                    }}
                  >
                    {/* The lifetime — the background. An issue that arrived through `evidence` is laid out with a dashed border: that it is a
                        relation derived from evidence rather than a link a person declared is itself information. */}
                    <span
                      {...enter('issues', card((start + end) / 2))}
                      className={cn(
                        'absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full',
                        bar,
                        issue.via === 'evidence' && 'opacity-70'
                      )}
                    />
                    {/* Opened — the diamond at the left end. */}
                    <span
                      {...enter('issues', card(start, t('momentRaised')))}
                      className={cn(
                        'absolute left-0 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border',
                        ink
                      )}
                    />
                    {/* Resolved — the circle at the right end. Still open means no marker: putting an end point on work that has not ended is
                        not a fact, it is a prophecy. */}
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
            // Drop a tick that collides with the today label — two dates in one place making each other unreadable is the worse trade.
            if (Math.abs(tick.pct - nowPct) < 9) return null
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
          {/* Today — the one emphasised date on the axis, in the same place as the line above. Pinned at the right edge (the ordinary case,
              where the window ends today) centring would clip the label out of the container, so its right end is aligned to the line. */}
          <span
            className="absolute top-0 whitespace-nowrap font-mono text-[10px] text-primary"
            style={
              nowPct > 93
                ? { right: `${Math.max(0, 100 - nowPct)}%` }
                : { left: `${nowPct}%`, transform: 'translateX(-50%)' }
            }
          >
            {t('today')}
          </span>
        </div>
      </div>
    </div>
  )
}

// The card that appears directly under a mark. At either end of the axis a card would be clipped, so its alignment flips — the
// rightmost dot is usually the most recent event, and hover means nothing if that one cannot be read.
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
