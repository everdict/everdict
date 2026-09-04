'use client'

import { useEffect, useState } from 'react'
import type { TopologyStatus } from '@everdict/contracts/wire'
import { useTranslations } from 'next-intl'

import { fmtDurationMs } from '@/shared/lib/format'
import { displayImageRef } from '@/shared/lib/image-ref'
import { cn } from '@/shared/lib/utils'
import { AnsiText } from '@/shared/ui/ansi-text'
import { Card } from '@/shared/ui/card'
import { SectionHeader } from '@/shared/ui/section-header'

const TERMINAL = new Set(['succeeded', 'failed', 'superseded', 'cancelled'])
const POLL_MS = 5000

// The topology health panel (runtime debugging, service harnesses) — it polls a warm topology's per-service detail every 5s:
// the declared identity (role, image, port) and the live state (status, readiness, restarts, OOM, node, resources, age, endpoints) as one row
// per service, expanding to the orchestrator event feed plus a log tail (fetched on demand, once).
// A run that is not a service harness (found=false) hides entirely until the first discovery (no empty sections).
export function RunTopology({ runId, initialStatus }: { runId: string; initialStatus: string }) {
  const t = useTranslations('runTopology')
  const [topology, setTopology] = useState<TopologyStatus | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [logs, setLogs] = useState<Record<string, string | undefined>>({})

  useEffect(() => {
    if (TERMINAL.has(initialStatus)) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/topology`)
        if (res.ok) {
          const body = (await res.json()) as {
            status: string
            found: boolean
            topology: TopologyStatus | null
          }
          if (stopped) return
          if (body.found && body.topology) setTopology(body.topology)
          if (TERMINAL.has(body.status)) return // the run ended — keep the last roster and stop polling
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

  // Row expansion — the event feed already rides on the roster, so only the logs are fetched on demand, once.
  const toggle = async (service: string) => {
    const next = !open[service]
    setOpen((prev) => ({ ...prev, [service]: next }))
    if (!next || logs[service] !== undefined) return
    try {
      const res = await fetch(
        `/api/runs/${encodeURIComponent(runId)}/topology/${encodeURIComponent(service)}/logs`
      )
      if (!res.ok) return
      const body = (await res.json()) as { found: boolean; text: string }
      setLogs((prev) => ({ ...prev, [service]: body.found ? body.text : t('noLogs') }))
    } catch {
      // best-effort — left as no logs
    }
  }

  // Not a service harness, or before the first roster — hidden entirely.
  if (!topology) return null

  return (
    <div className="space-y-2.5">
      <SectionHeader title={t('title')} />
      <Card className="divide-y divide-border p-0">
        {!topology.deployed && (
          <p className="px-4 py-3 text-[12.5px] text-muted-foreground">{t('notDeployed')}</p>
        )}
        {/* The session pool — a resource INSIDE the service container, so it is invisible to the orchestrator roster. When a batch is wider than
            the pool the service is healthy and only the cases keep being refused, so this line makes that cause visible. */}
        {topology.pool && (
          <div className="flex items-center gap-2 px-4 py-2.5">
            <span className="text-[11.5px] text-faint">{t('poolLabel')}</span>
            <span className="font-mono text-[12.5px]">
              {topology.pool.used !== undefined
                ? t('poolInUse', { used: topology.pool.used, total: topology.pool.total })
                : t('poolTotal', { total: topology.pool.total })}
            </span>
            {topology.pool.used !== undefined && topology.pool.used >= topology.pool.total && (
              <span className="rounded bg-[var(--color-warning)]/15 px-1.5 py-0.5 text-[11px] text-[var(--color-warning)]">
                {t('poolFull')}
              </span>
            )}
          </div>
        )}
        {topology.services.map((svc) => {
          // The live detail summary line — only entries with a value, joined by · (the empty-section convention).
          const rest = [
            svc.port !== undefined ? `:${svc.port}` : undefined,
            svc.node,
            svc.cpu !== undefined ? `cpu ${svc.cpu}` : undefined,
            svc.memoryMb !== undefined ? `${svc.memoryMb} MiB` : undefined,
            svc.ageSeconds !== undefined
              ? t('age', { age: fmtDurationMs(svc.ageSeconds * 1000) })
              : undefined,
          ].filter(Boolean)
          // The image carries an abbreviated digest — a 71-character digest eats the whole line and the tag, which
          // is the only readable version, is exactly what gets truncated away. The full ref stays on the title.
          const detail = [svc.image ? displayImageRef(svc.image) : undefined, ...rest].filter(
            Boolean
          )
          const detailTitle = [svc.image, ...rest].filter(Boolean).join(' · ')
          return (
            <div key={svc.name} className="px-4 py-2.5">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'inline-flex size-2 rounded-full',
                    svc.ready
                      ? 'bg-[var(--color-success)]'
                      : svc.oom
                        ? 'bg-destructive'
                        : 'bg-[var(--color-warning)]'
                  )}
                />
                <button
                  type="button"
                  onClick={() => void toggle(svc.name)}
                  className="font-mono text-[12.5px] font-medium hover:underline"
                >
                  {svc.name}
                </button>
                {svc.role && (
                  <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-faint">
                    {t(`role.${svc.role}`)}
                  </span>
                )}
                <span className="text-[11.5px] text-faint">{svc.status}</span>
                {svc.oom && (
                  <span className="rounded border border-destructive/40 px-1.5 py-0.5 font-mono text-[10.5px] text-destructive">
                    OOM
                  </span>
                )}
                {svc.restarts !== undefined && svc.restarts > 0 && (
                  <span className="rounded border border-[var(--color-warning)]/40 px-1.5 py-0.5 font-mono text-[10.5px] text-[var(--color-warning)]">
                    {t('restarts', { count: svc.restarts })}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void toggle(svc.name)}
                  className="ml-auto rounded px-1.5 py-0.5 font-mono text-[10.5px] text-faint transition-colors hover:bg-muted hover:text-muted-foreground"
                >
                  {open[svc.name] ? t('hideDetail') : t('showDetail')}
                </button>
              </div>
              {detail.length > 0 && (
                <p
                  className="mt-1 truncate font-mono text-[11px] text-muted-foreground/80"
                  title={detailTitle}
                >
                  {detail.join(' · ')}
                </p>
              )}
              {!open[svc.name] && svc.lastEvent && (
                <p
                  className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/60"
                  title={svc.lastEvent}
                >
                  {svc.lastEvent}
                </p>
              )}
              {open[svc.name] && (
                <div className="mt-2 space-y-2">
                  {svc.endpoint && (
                    <p className="font-mono text-[11px] text-muted-foreground">
                      <span className="text-faint">{t('endpoint')} </span>
                      {svc.endpoint}
                    </p>
                  )}
                  {svc.events.length > 0 && (
                    <div className="max-h-40 space-y-0.5 overflow-auto rounded-lg border border-border bg-muted/40 p-2.5">
                      {svc.events.map((e, i) => (
                        <div
                          key={`${e.at ?? ''}-${i}`}
                          className="flex gap-2 font-mono text-[11px] leading-relaxed"
                        >
                          {e.at && (
                            <span className="shrink-0 text-faint">{e.at.slice(11, 19)}</span>
                          )}
                          {e.type && (
                            <span className="shrink-0 text-muted-foreground">{e.type}</span>
                          )}
                          <span className="min-w-0 break-all text-muted-foreground/80">
                            {e.message}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    <AnsiText text={logs[svc.name] ?? t('loadingLogs')} />
                  </pre>
                </div>
              )}
            </div>
          )
        })}
      </Card>
    </div>
  )
}
