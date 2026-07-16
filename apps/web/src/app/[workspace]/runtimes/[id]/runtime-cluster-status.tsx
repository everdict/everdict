'use client'

import { useState, useTransition, type ReactNode } from 'react'
import {
  Ban,
  Boxes,
  Cpu,
  Database,
  Loader2,
  MemoryStick,
  Play,
  RefreshCw,
  Server,
  Square,
  Trash2,
} from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  controlRuntimeAction,
  inspectRuntimeAction,
  type InspectRuntimeActionResult,
} from '@/features/register-runtime'
import type { RuntimeControlCommand, RuntimeInspection } from '@/entities/runtime'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'

type InspectNode = NonNullable<RuntimeInspection['nodes']>['items'][number]
type InspectWorkload = NonNullable<RuntimeInspection['workload']>[number]

// A running/pending unit older than this reads as an idle-reclaim candidate. Stores are long-lived by design, so they're excluded.
const LONG_RUNNING_SECONDS = 30 * 60

// Compact duration (seconds → "45s"/"12m"/"3h"/"2d"). Display-only, best-effort.
function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

// CPU is in the runtime's native unit — Nomad MHz, K8s millicores (shown as cores). Memory is always MiB (→ GiB when large).
function formatCpu(n: number, kind: string): string {
  if (kind === 'k8s') {
    const cores = n / 1000
    return `${cores % 1 === 0 ? cores : cores.toFixed(1)} cores`
  }
  return `${n} MHz`
}
function formatMem(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GiB` : `${mb} MiB`
}

// A pending confirm — a destructive command plus the copy the modal shows for it.
interface Pending {
  command: RuntimeControlCommand
  title: string
  body: string
}

// A labeled usage bar (allocated / total). Renders nothing useful without a total, so callers guard on it.
function ResourceBar({
  icon,
  used,
  total,
  render,
}: {
  icon: ReactNode
  used: number
  total: number
  render: (n: number) => string
}) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
  const hot = pct >= 85
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="text-muted-foreground">{icon}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-secondary">
        <div
          className={`h-full rounded-full ${hot ? 'bg-amber-500' : 'bg-primary'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="shrink-0 font-mono text-faint">
        {render(used)} / {render(total)}
      </span>
    </div>
  )
}

// The live cluster view for a registered nomad/k8s runtime — a node-centric topology (each node card shows its
// resource usage + the workloads placed on it), loaded on demand (live I/O). When canControl (admin, runtimes:control)
// the destructive actions appear, each behind a confirm modal. A partial-cluster failure comes back in warnings.
export function RuntimeClusterStatus({
  id,
  version,
  canControl,
}: {
  id: string
  version: string
  canControl: boolean
}) {
  const t = useTranslations('runtimesPage')
  const [result, setResult] = useState<InspectRuntimeActionResult>()
  const [loading, start] = useTransition()
  const [pending, setPending] = useState<Pending>()
  const [actionMessage, setActionMessage] = useState<string>()
  const [running, startAction] = useTransition()

  function load() {
    setActionMessage(undefined)
    setResult(undefined)
    start(async () => setResult(await inspectRuntimeAction(id, version)))
  }

  function confirmRun() {
    const p = pending
    if (!p) return
    startAction(async () => {
      const r = await controlRuntimeAction(id, version, p.command)
      setPending(undefined)
      if (!r.ok) {
        setActionMessage(t('clusterActionFailed', { error: r.error ?? '' }))
        return
      }
      const res = r.result
      setActionMessage(
        res?.stopped !== undefined
          ? t('clusterStopped', { count: res.stopped })
          : res?.purged !== undefined
            ? t('clusterPurged', { count: res.purged })
            : t('clusterActionDone')
      )
      setResult(await inspectRuntimeAction(id, version)) // refresh
    })
  }

  const insp: RuntimeInspection | undefined = result?.ok ? result.inspection : undefined

  // Stop / cordon confirm builders (shared by node cards + unscheduled).
  const askStop = (w: InspectWorkload) =>
    setPending({
      command: { action: 'stopWorkload', name: w.name },
      title: t('clusterActionStop'),
      body: t('clusterConfirmStop', { name: w.name }),
    })
  const askCordon = (n: InspectNode) =>
    setPending({
      command: { action: 'cordonNode', node: n.name, schedulable: !n.schedulable },
      title: n.schedulable ? t('clusterActionCordon') : t('clusterActionUncordon'),
      body: n.schedulable
        ? t('clusterConfirmCordon', { node: n.name })
        : t('clusterConfirmUncordon', { node: n.name }),
    })

  // Group the workload by node (Lens-style): each node card lists its own units; node-less units → "unscheduled".
  const nodes = insp?.nodes?.items ?? []
  const workloads = insp?.workload ?? []
  const nodeNames = new Set(nodes.map((n) => n.name))
  const byNode = new Map<string, InspectWorkload[]>()
  const unscheduled: InspectWorkload[] = []
  for (const w of workloads) {
    if (w.node && nodeNames.has(w.node)) byNode.set(w.node, [...(byNode.get(w.node) ?? []), w])
    else unscheduled.push(w)
  }
  const sum = (ws: InspectWorkload[], k: 'cpu' | 'memoryMb') =>
    ws.reduce((a, w) => a + (w[k] ?? 0), 0)

  const workloadRow = (w: InspectWorkload) => {
    const idle = w.role !== 'store' && (w.ageSeconds ?? 0) >= LONG_RUNNING_SECONDS
    return (
      <div key={w.id} className="flex items-center gap-2 px-2.5 py-1">
        <span className="flex-1 truncate font-mono text-[11px]">{w.name}</span>
        <Badge tone={w.role === 'store' ? 'info' : 'neutral'}>{t(`clusterRole_${w.role}`)}</Badge>
        <span className="w-14 shrink-0 text-right text-[11px] text-muted-foreground">
          {w.status}
        </span>
        <span
          className={`w-9 shrink-0 text-right font-mono text-[11px] ${idle ? 'text-amber-500' : 'text-faint'}`}
          title={idle ? t('clusterLongRunning') : undefined}
        >
          {w.ageSeconds !== undefined ? formatAge(w.ageSeconds) : '—'}
        </span>
        {canControl && w.role !== 'store' ? (
          <button
            type="button"
            className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
            title={t('clusterActionStop')}
            onClick={() => askStop(w)}
          >
            <Square className="size-3" />
          </button>
        ) : (
          canControl && <span className="w-3 shrink-0" />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-[510]">
          <Server className="size-3.5 text-muted-foreground" />
          {t('clusterStatus')}
        </span>
        <div className="flex items-center gap-2">
          {canControl && insp?.reachable && (
            <Button
              variant="secondary"
              size="sm"
              className="gap-1.5"
              onClick={() =>
                setPending({
                  command: { action: 'purgeTerminal' },
                  title: t('clusterActionPurge'),
                  body: t('clusterConfirmPurge'),
                })
              }
            >
              <Trash2 className="size-3.5" />
              {t('clusterActionPurge')}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={load}
            disabled={loading}
            className="gap-1.5"
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {result ? t('clusterRefresh') : t('clusterLoad')}
          </Button>
        </div>
      </div>

      {actionMessage && (
        <Callout tone="info" className="py-1.5">
          {actionMessage}
        </Callout>
      )}
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

          {/* Capacity — does this cluster have room to run jobs right now (concurrent eval slots). */}
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
                {t('clusterUsedOfTotal', { used: insp.capacity.used, total: insp.capacity.total })}
              </span>
            </div>
          )}

          {/* Node-centric topology — one card per node: resource usage bars + the workloads placed on it + cordon. */}
          {insp.nodes && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Boxes className="size-3.5" />
                {t('clusterNodes', { ready: insp.nodes.ready, total: insp.nodes.total })}
                {insp.cluster?.datacenters && insp.cluster.datacenters.length > 0 ? (
                  <span className="text-faint">· {insp.cluster.datacenters.join(', ')}</span>
                ) : null}
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                {insp.nodes.items.map((n) => {
                  const units = byNode.get(n.name) ?? []
                  return (
                    <div key={n.name} className="space-y-2 rounded-md border border-border p-2.5">
                      <div className="flex items-center gap-2">
                        <span
                          className={`size-1.5 rounded-full ${n.ready ? 'bg-emerald-500' : 'bg-amber-500'}`}
                        />
                        <span className="flex-1 truncate font-mono text-[12px]">{n.name}</span>
                        {n.datacenter ? (
                          <span className="text-[11px] text-faint">{n.datacenter}</span>
                        ) : null}
                        {n.dockerHealthy === false ? (
                          <span className="text-[11px] text-amber-500">
                            {t('clusterDockerDown')}
                          </span>
                        ) : null}
                        {n.schedulable === false ? (
                          <span className="text-[11px] text-faint">{t('clusterCordoned')}</span>
                        ) : null}
                        {canControl && n.schedulable !== undefined ? (
                          <button
                            type="button"
                            className="text-muted-foreground transition-colors hover:text-foreground"
                            title={
                              n.schedulable ? t('clusterActionCordon') : t('clusterActionUncordon')
                            }
                            onClick={() => askCordon(n)}
                          >
                            {n.schedulable ? (
                              <Ban className="size-3" />
                            ) : (
                              <Play className="size-3" />
                            )}
                          </button>
                        ) : null}
                      </div>
                      {n.cpuTotal !== undefined ? (
                        <ResourceBar
                          icon={<Cpu className="size-3" />}
                          used={sum(units, 'cpu')}
                          total={n.cpuTotal}
                          render={(v) => formatCpu(v, insp.kind)}
                        />
                      ) : null}
                      {n.memoryMbTotal !== undefined ? (
                        <ResourceBar
                          icon={<MemoryStick className="size-3" />}
                          used={sum(units, 'memoryMb')}
                          total={n.memoryMbTotal}
                          render={formatMem}
                        />
                      ) : null}
                      {units.length > 0 ? (
                        <div className="divide-y divide-border/60 rounded border border-border/60">
                          {units.map(workloadRow)}
                        </div>
                      ) : (
                        <p className="text-[11px] text-faint">{t('clusterNodeEmpty')}</p>
                      )}
                    </div>
                  )
                })}
              </div>
              {/* Node-less units (pending placement / no node info) + a bulk reclaim of idle eval units. */}
              {(unscheduled.length > 0 ||
                (canControl && workloads.some((w) => w.role !== 'store'))) && (
                <div className="space-y-1.5 rounded-md border border-dashed border-border p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] text-muted-foreground">
                      {t('clusterUnscheduled', { count: unscheduled.length })}
                    </span>
                    {canControl && workloads.some((w) => w.role !== 'store') && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 gap-1 px-1.5 text-[12px]"
                        onClick={() =>
                          setPending({
                            command: {
                              action: 'reclaimIdle',
                              olderThanSeconds: LONG_RUNNING_SECONDS,
                            },
                            title: t('clusterActionReclaim'),
                            body: t('clusterConfirmReclaim', {
                              minutes: LONG_RUNNING_SECONDS / 60,
                            }),
                          })
                        }
                      >
                        <Ban className="size-3" />
                        {t('clusterActionReclaim')}
                      </Button>
                    )}
                  </div>
                  {unscheduled.length > 0 && (
                    <div className="divide-y divide-border/60 rounded border border-border/60">
                      {unscheduled.map(workloadRow)}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* When node listing degraded, fall back to a flat workload list so the units are still visible. */}
          {!insp.nodes && insp.workload && (
            <div className="space-y-1.5">
              <div className="text-muted-foreground">
                {t('clusterWorkload', { count: insp.workload.length })}
              </div>
              {insp.workload.length > 0 ? (
                <div className="divide-y divide-border rounded-md border border-border">
                  {insp.workload.map(workloadRow)}
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

          {insp.warnings.length > 0 && (
            <Callout tone="warning" className="py-1.5">
              {t('clusterWarnings', { warnings: insp.warnings.join('; ') })}
            </Callout>
          )}
        </div>
      )}

      {/* Confirm modal — every destructive action passes through here (hard-to-reverse cluster ops). */}
      <Dialog
        open={pending !== undefined}
        onClose={() => (running ? undefined : setPending(undefined))}
      >
        <div className="max-w-md space-y-4 p-5">
          <h3 className="text-[14px] font-[560]">{pending?.title}</h3>
          <p className="text-[13px] leading-relaxed text-muted-foreground">{pending?.body}</p>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPending(undefined)}
              disabled={running}
            >
              {t('clusterCancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={confirmRun}
              disabled={running}
              className="gap-1.5"
            >
              {running ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t('clusterConfirm')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
