'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

import type { CasePlacement } from '@everdict/contracts/wire'
import { fmtDurationMs } from '@/shared/lib/format'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { SectionHeader } from '@/shared/ui/section-header'
import { cn } from '@/shared/lib/utils'

const TERMINAL = new Set(['succeeded', 'failed', 'superseded', 'cancelled'])
const POLL_MS = 5000

// A placement phase → its display colour (semantic): blocked = warning, dead = danger, running = success, everything else = neutral.
const PHASE_DOT: Record<CasePlacement['phase'], string> = {
  queued: 'bg-muted-foreground/60',
  blocked: 'bg-[var(--color-warning)]',
  starting: 'bg-primary',
  running: 'bg-[var(--color-success)]',
  dead: 'bg-destructive',
}

// The case placement panel (runtime debugging) — it polls every 5s for how far a case job got inside the cluster:
// queued (waiting on the scheduler) · blocked (out of capacity — the scheduler's verdict is shown) · starting (an image pull, etc.) · running · dead.
// A run with no placement information at all (a self-hosted lane, pre-dispatch) hides entirely until the first discovery (no empty sections).
// Once the run ends, polling stops and the last read is left standing.
export function RunPlacement({ runId, initialStatus }: { runId: string; initialStatus: string }) {
  const t = useTranslations('runPlacement')
  const [placement, setPlacement] = useState<CasePlacement | null>(null)

  useEffect(() => {
    if (TERMINAL.has(initialStatus)) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/placement`)
        if (res.ok) {
          const body = (await res.json()) as {
            status: string
            found: boolean
            placement: CasePlacement | null
          }
          if (stopped) return
          if (body.found && body.placement) setPlacement(body.placement)
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

  // A run with no placement read yet, or none at all — hidden entirely rather than shown as an empty box.
  if (!placement) return null

  const meta: Array<{ label: string; value: string }> = [
    ...(placement.node ? [{ label: t('node'), value: placement.node }] : []),
    ...(placement.unit ? [{ label: t('unit'), value: placement.unit }] : []),
    ...(placement.job ? [{ label: t('job'), value: placement.job }] : []),
    ...(placement.namespace ? [{ label: t('namespace'), value: placement.namespace }] : []),
    ...(placement.cpu !== undefined ? [{ label: 'CPU', value: String(placement.cpu) }] : []),
    ...(placement.memoryMb !== undefined
      ? [{ label: t('memory'), value: `${placement.memoryMb} MiB` }]
      : []),
    ...(placement.ageSeconds !== undefined
      ? [{ label: t('age'), value: fmtDurationMs(placement.ageSeconds * 1000) }]
      : []),
    ...(placement.restarts !== undefined && placement.restarts > 0
      ? [{ label: t('restarts'), value: String(placement.restarts) }]
      : []),
  ]

  return (
    <div className="space-y-2.5">
      <SectionHeader title={t('title')} />
      <Card className="space-y-2.5 p-4">
        <div className="flex items-center gap-2">
          <span className={cn('inline-flex size-2 rounded-full', PHASE_DOT[placement.phase])} />
          <span className="text-[13px] font-medium">{t(`phase.${placement.phase}`)}</span>
          {placement.oom && (
            <span className="rounded border border-destructive/40 px-1.5 py-0.5 font-mono text-[10.5px] text-destructive">
              OOM
            </span>
          )}
        </div>
        {placement.blockedReason && (
          <Callout tone="warning" hint={placement.blockedReason}>
            {t('blocked')}
          </Callout>
        )}
        {meta.length > 0 && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
            {meta.map((m) => (
              <div key={m.label} className="min-w-0">
                <dt className="text-[11px] text-faint">{m.label}</dt>
                <dd
                  className="truncate font-mono text-[11.5px] text-muted-foreground"
                  title={m.value}
                >
                  {m.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {placement.events.length > 0 && (
          <div className="max-h-48 space-y-0.5 overflow-auto rounded-lg border border-border bg-muted/40 p-2.5">
            {placement.events.map((e, i) => (
              <div
                key={`${e.at ?? ''}-${i}`}
                className="flex gap-2 font-mono text-[11px] leading-relaxed"
              >
                {e.at && <span className="shrink-0 text-faint">{e.at.slice(11, 19)}</span>}
                {e.type && <span className="shrink-0 text-muted-foreground">{e.type}</span>}
                <span className="min-w-0 break-all text-muted-foreground/80">{e.message}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
