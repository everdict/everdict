'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Laptop, Loader2, Server } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { z } from 'zod'

import { runnerMetaSchema, type RunnerMeta } from '@/entities/runner'
import { runtimesSchema, type RuntimeSummary } from '@/entities/runtime'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'

import { useInfraPanel } from '../model/infra-panel-context'

// Runtimes tab — the execution-infra roster at a glance: workspace runtimes (registered infra) + my self-hosted
// runners with their live connectivity. A compact status surface; deep management stays on the full runtimes page.

const POLL_MS = 10_000
// Online check — a runner refreshes lastSeenAt on every long-poll lease (~25s), so within 90s it counts as connected
// (same convention as the runners managers).
const ONLINE_WINDOW_MS = 90_000

const rosterSchema = z.object({
  runtimes: runtimesSchema,
  runners: z.array(runnerMetaSchema),
})

function isOnline(lastSeenAt?: string): boolean {
  return lastSeenAt !== undefined && Date.now() - new Date(lastSeenAt).getTime() < ONLINE_WINDOW_MS
}

export function RuntimesTab({ onNavigate }: { onNavigate: () => void }) {
  const t = useTranslations('infraPanel')
  const { workspace } = useInfraPanel()
  const [roster, setRoster] = useState<{
    runtimes: RuntimeSummary[]
    runners: RunnerMeta[]
  } | null>(null)

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await fetch('/api/runtimes', { cache: 'no-store' })
        if (res.ok) {
          const parsed = rosterSchema.safeParse(await res.json())
          if (stopped) return
          if (parsed.success) setRoster(parsed.data)
        }
      } catch {
        // transient — keep polling
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  if (!roster)
    return (
      <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-faint">
        <Loader2 className="size-3.5 animate-spin" /> {t('loading')}
      </div>
    )

  if (roster.runtimes.length === 0 && roster.runners.length === 0)
    return <p className="py-8 text-center text-[12.5px] text-faint">{t('runtimesEmpty')}</p>

  return (
    <div className="space-y-4 px-3.5 py-3.5">
      {roster.runtimes.length > 0 && (
        <section className="space-y-1">
          <div className="flex items-center gap-1.5 text-[10.5px] font-[510] uppercase tracking-wide text-faint">
            {t('workspaceRuntimes')}
            <span className="tabular-nums text-muted-foreground">{roster.runtimes.length}</span>
          </div>
          <div className="space-y-1">
            {roster.runtimes.map((r) => (
              <Link
                key={r.id}
                href={`/${workspace}/runtimes/${encodeURIComponent(r.id)}`}
                onClick={onNavigate}
                className="flex items-center gap-2 rounded-md border bg-card px-2 py-1.5 transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <Server className="size-3.5 shrink-0 text-[#6ec6a8]" />
                <span className="min-w-0 flex-1 truncate text-[12px] font-[510]">{r.id}</span>
                {(r.capabilities ?? []).map((c) => (
                  <Badge key={c} tone="neutral" className="hidden shrink-0 sm:inline-flex">
                    {c}
                  </Badge>
                ))}
                <span className="shrink-0 font-mono text-[10.5px] text-faint">
                  {t('versionCount', { n: r.versions.length })}
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {roster.runners.length > 0 && (
        <section className="space-y-1">
          <div className="flex items-center gap-1.5 text-[10.5px] font-[510] uppercase tracking-wide text-faint">
            {t('myRunners')}
            <span className="tabular-nums text-muted-foreground">{roster.runners.length}</span>
          </div>
          <div className="space-y-1">
            {roster.runners.map((r) => {
              const online = isOnline(r.lastSeenAt)
              return (
                <Link
                  key={r.id}
                  href={`/${workspace}/runtimes/self/${encodeURIComponent(r.id)}`}
                  onClick={onNavigate}
                  className="flex items-center gap-2 rounded-md border bg-card px-2 py-1.5 transition-colors hover:border-border-strong hover:bg-elevated"
                >
                  <Laptop className="size-3.5 shrink-0 text-[#6ec6a8]" />
                  <span
                    aria-hidden
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      online ? 'bg-[#6ec6a8]' : 'bg-muted-foreground/40'
                    )}
                  />
                  <span className="min-w-0 flex-1 space-y-0.5 overflow-hidden whitespace-nowrap">
                    <span className="block truncate text-[12px] font-[510]">{r.label}</span>
                    {r.status && (
                      <span
                        className={cn(
                          'block truncate text-[10.5px]',
                          r.status.level === 'error'
                            ? 'text-[var(--color-destructive)]'
                            : r.status.level === 'warn'
                              ? 'text-[var(--color-warning)]'
                              : 'text-faint'
                        )}
                      >
                        {r.status.text}
                      </span>
                    )}
                  </span>
                  {r.updateRequired && (
                    <Badge tone="info" className="shrink-0">
                      {t('updateRequired')}
                    </Badge>
                  )}
                  <Badge tone={online ? 'success' : 'neutral'} className="shrink-0">
                    {online ? t('online') : t('offline')}
                  </Badge>
                  {r.lastSeenAt && !online && (
                    <time
                      className="shrink-0 font-mono text-[10.5px] text-faint"
                      title={fmtDateTimeFull(r.lastSeenAt)}
                    >
                      {fmtDateTime(r.lastSeenAt)}
                    </time>
                  )}
                </Link>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
