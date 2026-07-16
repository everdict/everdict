'use client'

import { useState, useTransition } from 'react'
import {
  Ban,
  Boxes,
  Cpu,
  Database,
  Loader2,
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

// A running/pending unit older than this reads as an idle-reclaim candidate (worth a glance). Stores are long-lived by design, so they're excluded.
const LONG_RUNNING_SECONDS = 30 * 60

// Compact duration for a workload unit's age (seconds → "45s"/"12m"/"3h"/"2d"). Display-only, best-effort.
function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

// A pending confirm — a destructive command plus the copy the modal shows for it.
interface Pending {
  command: RuntimeControlCommand
  title: string
  body: string
}

// The live cluster view for a registered nomad/k8s runtime — loaded on demand (live I/O). Shows the cluster's
// composition (nodes), whether it has capacity, the everdict workload currently on it (with idle hints), and any
// shared stores. Read-only; a partial-cluster failure comes back inside inspection.warnings, never as a failure.
// When canControl (admin, runtimes:control) the destructive actions appear, each behind a confirm modal.
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

  // Run the confirmed command, then re-inspect so the panel reflects the new cluster state.
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
      setResult(await inspectRuntimeAction(id, version)) // refresh the view
    })
  }

  const insp: RuntimeInspection | undefined = result?.ok ? result.inspection : undefined

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
                {t('clusterUsedOfTotal', { used: insp.capacity.used, total: insp.capacity.total })}
              </span>
            </div>
          )}

          {/* Nodes — the cluster's composition + readiness (docker-driver health for Nomad); cordon/uncordon per node. */}
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
                    {n.schedulable === false ? (
                      <span className="text-faint">{t('clusterCordoned')}</span>
                    ) : null}
                    {canControl && n.schedulable !== undefined ? (
                      <button
                        type="button"
                        className="text-muted-foreground transition-colors hover:text-foreground"
                        title={
                          n.schedulable ? t('clusterActionCordon') : t('clusterActionUncordon')
                        }
                        onClick={() =>
                          setPending({
                            command: {
                              action: 'cordonNode',
                              node: n.name,
                              schedulable: !n.schedulable,
                            },
                            title: n.schedulable
                              ? t('clusterActionCordon')
                              : t('clusterActionUncordon'),
                            body: n.schedulable
                              ? t('clusterConfirmCordon', { node: n.name })
                              : t('clusterConfirmUncordon', { node: n.name }),
                          })
                        }
                      >
                        {n.schedulable ? <Ban className="size-3" /> : <Play className="size-3" />}
                      </button>
                    ) : null}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Live workload — the everdict jobs currently placed here; a long-running one is a reclaim candidate. */}
          {insp.workload && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">
                  {t('clusterWorkload', { count: insp.workload.length })}
                </span>
                {canControl && insp.workload.some((w) => w.role !== 'store') && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 gap-1 px-1.5 text-[12px]"
                    onClick={() =>
                      setPending({
                        command: { action: 'reclaimIdle', olderThanSeconds: LONG_RUNNING_SECONDS },
                        title: t('clusterActionReclaim'),
                        body: t('clusterConfirmReclaim', { minutes: LONG_RUNNING_SECONDS / 60 }),
                      })
                    }
                  >
                    <Ban className="size-3" />
                    {t('clusterActionReclaim')}
                  </Button>
                )}
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
                          {canControl && w.role !== 'store' ? (
                            <button
                              type="button"
                              className="shrink-0 text-muted-foreground transition-colors hover:text-destructive"
                              title={t('clusterActionStop')}
                              onClick={() =>
                                setPending({
                                  command: { action: 'stopWorkload', name: w.name },
                                  title: t('clusterActionStop'),
                                  body: t('clusterConfirmStop', { name: w.name }),
                                })
                              }
                            >
                              <Square className="size-3" />
                            </button>
                          ) : (
                            canControl && <span className="w-3 shrink-0" />
                          )}
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
