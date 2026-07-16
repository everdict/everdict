'use client'

import { useState, useTransition } from 'react'
import { Boxes, Cpu, Database, Loader2, RefreshCw, Server } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { inspectRuntimeAction, type InspectRuntimeActionResult } from '@/features/register-runtime'
import type { RuntimeInspection } from '@/entities/runtime'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'

// A running/pending unit older than this reads as an idle-reclaim candidate (worth a glance). Stores are long-lived by design, so they're excluded.
const LONG_RUNNING_SECONDS = 30 * 60

// Compact duration for a workload unit's age (seconds → "45s"/"12m"/"3h"/"2d"). Display-only, best-effort.
function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

// The live cluster view for a registered nomad/k8s runtime — loaded on demand (live I/O). Shows the cluster's
// composition (nodes), whether it has capacity, the everdict workload currently on it (with idle hints), and any
// shared stores. Read-only; a partial-cluster failure comes back inside inspection.warnings, never as a failure.
export function RuntimeClusterStatus({ id, version }: { id: string; version: string }) {
  const t = useTranslations('runtimesPage')
  const [result, setResult] = useState<InspectRuntimeActionResult>()
  const [loading, start] = useTransition()

  function load() {
    setResult(undefined)
    start(async () => setResult(await inspectRuntimeAction(id, version)))
  }

  const insp: RuntimeInspection | undefined = result?.ok ? result.inspection : undefined

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-[510]">
          <Server className="size-3.5 text-muted-foreground" />
          {t('clusterStatus')}
        </span>
        <Button variant="secondary" size="sm" onClick={load} disabled={loading} className="gap-1.5">
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {result ? t('clusterRefresh') : t('clusterLoad')}
        </Button>
      </div>

      {result && !result.ok && (
        <Callout tone="danger" className="py-1.5">
          {t('clusterError', { error: result.error ?? '' })}
        </Callout>
      )}

      {insp && !insp.reachable && (
        <Callout tone="warning">
          {t('clusterUnreachable')}
          {insp.detail ? ` — ${insp.detail}` : ''}
        </Callout>
      )}

      {insp?.reachable && (
        <div className="space-y-3 text-[13px]">
          <p className="text-muted-foreground">{insp.detail}</p>

          {/* Capacity — does this cluster have room to run jobs right now. */}
          {insp.capacity && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-md border border-border px-3 py-2">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Cpu className="size-3.5" />
                {t('clusterCapacity')}
              </span>
              <span>
                <span className="font-mono">{insp.capacity.free}</span>{' '}
                <span className="text-muted-foreground">{t('clusterFree')}</span>
              </span>
              <span className="text-faint">
                {t('clusterUsedOfTotal', {
                  used: insp.capacity.used,
                  total: insp.capacity.total,
                })}
              </span>
            </div>
          )}

          {/* Nodes — the cluster's composition + readiness (docker-driver health for Nomad). */}
          {insp.nodes && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Boxes className="size-3.5" />
                {t('clusterNodes', { ready: insp.nodes.ready, total: insp.nodes.total })}
                {insp.cluster?.datacenters && insp.cluster.datacenters.length > 0 ? (
                  <span className="text-faint">· {insp.cluster.datacenters.join(', ')}</span>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {insp.nodes.items.map((n) => (
                  <span
                    key={n.name}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1"
                  >
                    <span
                      className={`size-1.5 rounded-full ${n.ready ? 'bg-emerald-500' : 'bg-amber-500'}`}
                    />
                    <span className="font-mono">{n.name}</span>
                    {n.dockerHealthy === false ? (
                      <span className="text-amber-500">{t('clusterDockerDown')}</span>
                    ) : null}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Live workload — the everdict jobs currently placed here; a long-running one is a reclaim candidate. */}
          {insp.workload && (
            <div className="space-y-1.5">
              <div className="text-muted-foreground">
                {t('clusterWorkload', { count: insp.workload.length })}
              </div>
              {insp.workload.length > 0 ? (
                <div className="overflow-x-auto">
                  <div className="min-w-[360px] divide-y divide-border rounded-md border border-border">
                    {insp.workload.map((w) => {
                      const idle = w.role !== 'store' && (w.ageSeconds ?? 0) >= LONG_RUNNING_SECONDS
                      return (
                        <div key={w.id} className="flex items-center gap-3 px-3 py-1.5">
                          <span className="flex-1 truncate font-mono text-[12px]">{w.name}</span>
                          <Badge tone={w.role === 'store' ? 'info' : 'neutral'}>
                            {t(`clusterRole_${w.role}`)}
                          </Badge>
                          <span className="w-16 shrink-0 text-right text-muted-foreground">
                            {w.status}
                          </span>
                          <span
                            className={`w-12 shrink-0 text-right font-mono ${idle ? 'text-amber-500' : 'text-faint'}`}
                            title={idle ? t('clusterLongRunning') : undefined}
                          >
                            {w.ageSeconds !== undefined ? formatAge(w.ageSeconds) : '—'}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : (
                <p className="text-[12px] text-faint">{t('clusterNoWorkload')}</p>
              )}
            </div>
          )}

          {/* Shared stores standing on the cluster — with their connection address where known. */}
          {insp.stores && insp.stores.length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Database className="size-3.5" />
                {t('clusterStores')}
              </div>
              <div className="divide-y divide-border rounded-md border border-border">
                {insp.stores.map((s) => (
                  <div key={s.name} className="flex items-center gap-3 px-3 py-1.5">
                    <span className="font-mono text-[12px]">{s.name}</span>
                    <span className="flex-1 truncate text-right font-mono text-[12px] text-muted-foreground">
                      {s.address ?? t('clusterAddressDynamic')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Honest degradation — which sub-reads failed, so partial data doesn't read as "all clear". */}
          {insp.warnings.length > 0 && (
            <Callout tone="warning" className="py-1.5">
              {t('clusterWarnings', { warnings: insp.warnings.join('; ') })}
            </Callout>
          )}
        </div>
      )}
    </div>
  )
}
