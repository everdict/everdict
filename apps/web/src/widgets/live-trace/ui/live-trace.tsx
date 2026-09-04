'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'

import { asSingleSegment, TrajectoryView } from '@/features/browse-traces'
import { traceEventSchema, type TraceEvent } from '@/entities/trace'
import { Card } from '@/shared/ui/card'
import { SectionHeader } from '@/shared/ui/section-header'

const TERMINAL = new Set(['succeeded', 'failed', 'superseded', 'cancelled'])
const POLL_MS = 3000

// The live trace panel (observability ⑨) — it polls every 3s and draws a running run's trajectory as it accumulates:
// the dispatch batch marks (accepted → queued → started) plus runner-pushed batches plus a managed job's event sentinels. The semantics are
// SNAPSHOT, so every poll returns everything so far and the widget replaces it whole (no diffing — the same choice as LiveLogs).
// With no event yet it hides entirely (no empty sections); once the run ends it stops polling and leaves the last read
// standing — the sealed evidence section is the authoritative surface and this panel is its preview.
export function LiveTrace({ runId, initialStatus }: { runId: string; initialStatus: string }) {
  const t = useTranslations('liveTraceView')
  const [events, setEvents] = useState<TraceEvent[]>([])
  const [status, setStatus] = useState(initialStatus)

  useEffect(() => {
    if (TERMINAL.has(initialStatus)) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // ── THE POLL CARRIES WHAT CHANGED, NOT WHAT EXISTS ──────────────────────────────────────────────
    //
    // This asked for the whole buffer every 3 seconds and re-validated every event through the trace union
    // before replacing the list. On a five-hour agent run that is the entire cost of the panel, paid twenty
    // times a minute for hours, while almost nothing has changed between two of them.
    //
    // `after` carries the reader's absolute cursor and the reply says whether the page CONTINUES what is
    // held. It usually does, so the parse and the re-render scale with the new events; when it does not (the
    // server's ring evicted events this reader never saw) the reply says `incremental: false` and the list
    // is redrawn — appending onto that hole would render a trace the run never produced.
    let cursor: number | undefined
    const tick = async () => {
      try {
        const qs = cursor === undefined ? '' : `?after=${cursor}`
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/trajectory/live${qs}`)
        if (res.ok) {
          const body = (await res.json()) as {
            status: string
            found: boolean
            events: unknown[]
            incremental?: boolean
            next?: number
          }
          if (stopped) return
          setStatus(body.status)
          // The same per-event strict lens as the page's toEvidence: a kind this build does not know drops only THAT event and the rest
          // still draw — so the live view does not empty entirely when the server grows its vocabulary.
          const evidence: TraceEvent[] = []
          for (const event of body.events) {
            const parsed = traceEventSchema.safeParse(event)
            if (parsed.success) evidence.push(parsed.data)
          }
          // A server that predates the cursor sends no `incremental`; treating that absence as "replace" keeps
          // the old behaviour exactly, which is the safe direction for a field that decides append-vs-redraw.
          const appends = body.incremental === true && cursor !== undefined
          setEvents((held) => (appends ? (evidence.length > 0 ? [...held, ...evidence] : held) : evidence))
          if (typeof body.next === 'number') cursor = body.next
          if (TERMINAL.has(body.status)) return // the run ended — keep the last read and stop polling
        }
      } catch {
        // a transient error — keep polling
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [runId, initialStatus])

  // The same read surface as the sealed evidence view (TrajectoryView) — live is the execution's own single segment.
  const segments = useMemo(() => asSingleSegment(events, 'run'), [events])

  // A run where nothing has arrived yet — hidden entirely rather than shown as an empty box.
  if (events.length === 0) return null

  const live = !TERMINAL.has(status)
  return (
    <div className="space-y-2.5">
      <SectionHeader
        title={t('title')}
        action={
          <span className="inline-flex items-center gap-1.5 text-[11.5px] text-faint">
            {live && (
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--color-success)] opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-[var(--color-success)]" />
              </span>
            )}
            {live ? t('streaming') : t('finished')}
          </span>
        }
      />
      <Card className="h-[48vh] min-h-[320px] p-4">
        <TrajectoryView segments={segments} />
      </Card>
    </div>
  )
}
