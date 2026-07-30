'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

import { summarizeTraceEvent, traceKindColor, type TraceEvent } from '@/entities/run'
import { cn } from '@/shared/lib/utils'

// The harness's own trace as it arrives — one flat row per event (kind dot · kind · one-line summary), reusing
// the entity-layer summary/colour so the playground, the trace timeline and the replay lane speak one vocabulary.
// A long run would push the composer off screen, so the list shows only its TAIL until the reader expands it;
// while collapsed it auto-follows (new events land at the bottom, which is where the eye already is).
const TAIL = 8

export function LiveTraceList({ events }: { events: TraceEvent[] }) {
  const t = useTranslations('playground')
  const [expanded, setExpanded] = useState(false)
  const endRef = useRef<HTMLLIElement>(null)

  useEffect(() => {
    if (!expanded) endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [events.length, expanded])

  if (events.length === 0)
    return <p className="px-1 text-[11.5px] text-muted-foreground">{t('waitingEvents')}</p>

  const hidden = expanded ? 0 : Math.max(0, events.length - TAIL)
  const shown = hidden > 0 ? events.slice(hidden) : events

  return (
    <div className="space-y-1">
      <ol className="space-y-0.5">
        {shown.map((event, index) => {
          const summary = summarizeTraceEvent(event)
          const last = index === shown.length - 1
          return (
            <li
              key={`${hidden + index}-${event.t}`}
              ref={last ? endRef : null}
              className="flex items-baseline gap-1.5 text-[11.5px] leading-relaxed"
            >
              <span
                className={cn(
                  'mt-[5px] size-1.5 shrink-0 rounded-full',
                  traceKindColor(event.kind)
                )}
              />
              <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70">
                {event.kind}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{summary}</span>
            </li>
          )
        })}
      </ol>
      {(hidden > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          {expanded ? t('collapseEvents') : t('showAllEvents', { count: events.length })}
        </button>
      )}
    </div>
  )
}
