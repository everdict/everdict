'use client'

import { useState, useTransition, type ReactNode } from 'react'
import { Ban, Loader2, Play, RefreshCw, Server, Trash2, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  controlRuntimeAction,
  inspectRuntimeAction,
  type InspectRuntimeActionResult,
} from '@/features/register-runtime'
import type { RuntimeControlCommand, RuntimeInspection } from '@/entities/runtime'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'

type InspectNode = NonNullable<RuntimeInspection['nodes']>['items'][number]
type InspectWorkload = NonNullable<RuntimeInspection['workload']>[number]

// A running/pending unit older than this reads as an idle-reclaim candidate. Stores are long-lived by design, so they're excluded.
const LONG_RUNNING_SECONDS = 30 * 60

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}
// CPU is in the runtime's native unit — Nomad MHz, K8s millicores. Both /1000 for display (GHz-equivalent / cores).
function formatCpu(n: number, kind: string): string {
  const v = n / 1000
  const s = v % 1 === 0 ? String(v) : v.toFixed(1)
  return kind === 'k8s' ? `${s} cores` : `${s} GHz`
}
function formatMem(mb: number): string {
  if (mb < 1024) return `${mb} MiB`
  const g = mb / 1024
  return `${g % 1 === 0 ? g : g.toFixed(1)} GiB`
}
const idleUnit = (w: InspectWorkload) =>
  w.role !== 'store' && (w.ageSeconds ?? 0) >= LONG_RUNNING_SECONDS

// A pending confirm — a destructive command plus the copy the modal shows for it.
interface Pending {
  command: RuntimeControlCommand
  title: string
  body: string
}

// A radial usage gauge (allocated / total) — the Lens signature. Colour shifts to amber/rose as load climbs.
function RadialGauge({
  label,
  used,
  total,
  render,
}: {
  label: string
  used: number
  total: number
  render: (n: number) => string
}) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
  const r = 20
  const c = 2 * Math.PI * r
  const color = pct >= 85 ? 'text-rose-500' : pct >= 65 ? 'text-amber-500' : 'text-primary'
  return (
    <div className="flex flex-1 items-center gap-2.5">
      <svg width="52" height="52" viewBox="0 0 52 52" className="-rotate-90">
        <circle
          cx="26"
          cy="26"
          r={r}
          fill="none"
          strokeWidth="5"
          stroke="currentColor"
          className="text-muted-foreground/15"
        />
        <circle
          cx="26"
          cy="26"
          r={r}
          fill="none"
          strokeWidth="5"
          strokeLinecap="round"
          stroke="currentColor"
          className={cn('transition-[stroke-dashoffset] duration-700 ease-out', color)}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
        />
      </svg>
      <div className="min-w-0">
        <div className={cn('font-mono text-[14px] font-[560] leading-none', color)}>{pct}%</div>
        <div className="mt-0.5 text-[9px] uppercase tracking-wider text-faint">{label}</div>
        <div className="font-mono text-[10px] text-muted-foreground">
          {render(used)} / {render(total)}
        </div>
      </div>
    </div>
  )
}

// One workload as a role-coloured chip with a hover tooltip (role/status/age/resources) + an inline stop for eval units.
function WorkloadChip({
  w,
  kind,
  canControl,
  onStop,
  stopLabel,
  idleTitle,
}: {
  w: InspectWorkload
  kind: string
  canControl: boolean
  onStop: () => void
  stopLabel: string
  idleTitle: string
}) {
  const idle = idleUnit(w)
  const dot = w.role === 'store' ? 'bg-cyan-400' : w.role === 'eval' ? 'bg-primary' : 'bg-faint'
  const tv =
    w.role === 'store' ? 'text-cyan-400' : w.role === 'eval' ? 'text-primary' : 'text-faint'
  return (
    <span className="group relative inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary py-1 pl-2 pr-1 transition-colors hover:border-border-strong">
      <span className={cn('size-1.5 shrink-0 rounded-[2px]', dot)} />
      <span
        className={cn('max-w-[120px] truncate font-mono text-[11px]', idle && 'text-amber-500')}
        title={idle ? idleTitle : undefined}
      >
        {w.name}
      </span>
      {canControl && w.role !== 'store' ? (
        <button
          type="button"
          title={stopLabel}
          onClick={onStop}
          className="hidden size-4 place-items-center rounded text-faint transition-colors hover:bg-rose-500/10 hover:text-rose-500 group-hover:grid"
        >
          <X className="size-2.5" />
        </button>
      ) : null}
      <span className="pointer-events-none absolute bottom-[calc(100%+7px)] left-1/2 z-20 w-max max-w-[220px] -translate-x-1/2 translate-y-1 space-y-1 rounded-lg border border-border-strong bg-popover p-2 opacity-0 shadow-pop transition-all duration-150 group-hover:translate-y-0 group-hover:opacity-100">
        <TipRow k="role" v={<span className={tv}>{w.role}</span>} />
        <TipRow k="status" v={idle ? `${w.status} · idle?` : w.status} />
        {w.ageSeconds !== undefined ? <TipRow k="age" v={formatAge(w.ageSeconds)} /> : null}
        {w.cpu !== undefined || w.memoryMb !== undefined ? (
          <TipRow
            k="cpu · mem"
            v={`${w.cpu !== undefined ? formatCpu(w.cpu, kind) : '—'} · ${w.memoryMb !== undefined ? formatMem(w.memoryMb) : '—'}`}
          />
        ) : null}
      </span>
    </span>
  )
}
function TipRow({ k, v }: { k: string; v: ReactNode }) {
  return (
    <span className="flex justify-between gap-4 whitespace-nowrap">
      <span className="text-[9px] uppercase tracking-wide text-faint">{k}</span>
      <span className="font-mono text-[10.5px]">{v}</span>
    </span>
  )
}

// The live cluster console for a registered nomad/k8s runtime — a Lens-style node topology (per-node usage gauges +
// the workloads placed on it), loaded on demand (live I/O). When canControl (admin) the destructive actions appear,
// each behind a confirm modal. A partial-cluster failure comes back in warnings.
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

  // Group the workload by node (Lens-style); node-less units → "unscheduled".
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
  const evalCount = workloads.filter((w) => w.role === 'eval').length
  const storeCount = workloads.filter((w) => w.role === 'store').length
  const idleCount = workloads.filter(idleUnit).length
  const reclaimable = canControl && workloads.some((w) => w.role !== 'store')

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-[510]">
          <Server className="size-3.5 text-muted-foreground" />
          {t('clusterStatus')}
        </span>
        <div className="flex items-center gap-2">
          {canControl && insp?.reachable ? (
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
          ) : null}
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

      {actionMessage ? (
        <Callout tone="info" className="py-1.5">
          {actionMessage}
        </Callout>
      ) : null}
      {result && !result.ok ? (
        <Callout tone="danger" className="py-1.5">
          {t('clusterError', { error: result.error ?? '' })}
        </Callout>
      ) : null}
      {insp && !insp.reachable ? (
        <Callout tone="warning">
          {t('clusterUnreachable')}
          {insp.detail ? ` — ${insp.detail}` : ''}
        </Callout>
      ) : null}

      {insp?.reachable ? (
        <div className="space-y-3">
          {/* Overview strip — summary first: hero capacity donut + node health + workload/idle summary. */}
          {insp.capacity ? (
            <div className="flex flex-wrap items-center gap-x-8 gap-y-4 rounded-xl border border-border bg-gradient-to-b from-secondary/50 to-transparent px-5 py-4">
              <div className="flex items-center gap-3.5">
                <CapacityDonut free={insp.capacity.free} total={insp.capacity.total} />
                <div className="space-y-0.5">
                  <div className="font-mono text-[22px] font-[600] leading-none tracking-tight">
                    {insp.capacity.free}
                    <span className="ml-1 text-[13px] font-normal text-muted-foreground">
                      / {insp.capacity.total}
                    </span>
                  </div>
                  <div className="text-[9.5px] uppercase tracking-[0.08em] text-faint">
                    {t('clusterFreeSlots')}
                  </div>
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {t('clusterUsedOfTotal', {
                      used: insp.capacity.used,
                      total: insp.capacity.total,
                    })}
                  </div>
                </div>
              </div>

              {insp.nodes ? (
                <OverviewStat
                  value={
                    <>
                      {insp.nodes.ready}
                      <span className="text-faint">/{insp.nodes.total}</span>
                    </>
                  }
                  label={t('clusterNodesReady')}
                  chips={insp.cluster?.datacenters}
                />
              ) : null}
              <OverviewStat
                value={workloads.length}
                label={t('clusterWorkloadShort')}
                chips={[t('clusterEvalStore', { eval: evalCount, store: storeCount })]}
              />
              {idleCount > 0 ? (
                <OverviewStat
                  value={<span className="text-amber-500">{idleCount}</span>}
                  label={t('clusterIdleCandidate')}
                  chips={[t('clusterRunningOver', { minutes: LONG_RUNNING_SECONDS / 60 })]}
                  warn
                />
              ) : null}
            </div>
          ) : null}

          {insp.detail ? <p className="text-[12px] text-muted-foreground">{insp.detail}</p> : null}

          {/* Node topology — one card per node: usage gauges + the workloads placed on it + cordon toggle. */}
          {insp.nodes ? (
            <div className="grid gap-3 md:grid-cols-2">
              {insp.nodes.items.map((n) => {
                const units = byNode.get(n.name) ?? []
                return (
                  <div
                    key={n.name}
                    className={cn(
                      'space-y-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-border-strong',
                      n.schedulable === false && 'bg-amber-500/[0.03]'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'size-2 shrink-0 rounded-full',
                          n.ready
                            ? 'bg-emerald-500 shadow-[0_0_8px_rgba(52,211,153,0.5)]'
                            : 'bg-rose-500'
                        )}
                      />
                      <span className="flex-1 truncate font-mono text-[12.5px] font-[510]">
                        {n.name}
                      </span>
                      {n.datacenter ? (
                        <span className="font-mono text-[10.5px] text-faint">{n.datacenter}</span>
                      ) : null}
                      {n.dockerHealthy === false ? (
                        <span className="text-[10px] text-rose-500">{t('clusterDockerDown')}</span>
                      ) : null}
                      {n.schedulable === false ? (
                        <span className="rounded border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-[600] uppercase tracking-wide text-amber-500">
                          {t('clusterCordoned')}
                        </span>
                      ) : null}
                      {canControl && n.schedulable !== undefined ? (
                        <button
                          type="button"
                          title={
                            n.schedulable ? t('clusterActionCordon') : t('clusterActionUncordon')
                          }
                          onClick={() => askCordon(n)}
                          className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        >
                          {n.schedulable ? (
                            <Ban className="size-3.5" />
                          ) : (
                            <Play className="size-3.5" />
                          )}
                        </button>
                      ) : null}
                    </div>

                    {n.cpuTotal !== undefined || n.memoryMbTotal !== undefined ? (
                      <div className="flex gap-4">
                        {n.cpuTotal !== undefined ? (
                          <RadialGauge
                            label={t('clusterCpu')}
                            used={sum(units, 'cpu')}
                            total={n.cpuTotal}
                            render={(v) => formatCpu(v, insp.kind)}
                          />
                        ) : null}
                        {n.memoryMbTotal !== undefined ? (
                          <RadialGauge
                            label={t('clusterMemory')}
                            used={sum(units, 'memoryMb')}
                            total={n.memoryMbTotal}
                            render={formatMem}
                          />
                        ) : null}
                      </div>
                    ) : null}

                    <div className="flex flex-wrap gap-1.5">
                      {units.length > 0 ? (
                        units.map((w) => (
                          <WorkloadChip
                            key={w.id}
                            w={w}
                            kind={insp.kind}
                            canControl={canControl}
                            onStop={() => askStop(w)}
                            stopLabel={t('clusterActionStop')}
                            idleTitle={t('clusterLongRunning')}
                          />
                        ))
                      ) : (
                        <span className="text-[11px] italic text-faint">
                          {t('clusterNodeEmpty')}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : null}

          {/* Node-less units (pending / no node info) + the bulk reclaim-idle action. */}
          {insp.nodes && (unscheduled.length > 0 || reclaimable) ? (
            <div className="space-y-2 rounded-xl border border-dashed border-border-strong px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] text-muted-foreground">
                  {t('clusterUnscheduled', { count: unscheduled.length })}
                </span>
                {reclaimable ? (
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
                ) : null}
              </div>
              {unscheduled.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {unscheduled.map((w) => (
                    <WorkloadChip
                      key={w.id}
                      w={w}
                      kind={insp.kind}
                      canControl={canControl}
                      onStop={() => askStop(w)}
                      stopLabel={t('clusterActionStop')}
                      idleTitle={t('clusterLongRunning')}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Fallback flat list when node listing degraded. */}
          {!insp.nodes && insp.workload ? (
            <div className="flex flex-wrap gap-1.5">
              {insp.workload.length > 0 ? (
                insp.workload.map((w) => (
                  <WorkloadChip
                    key={w.id}
                    w={w}
                    kind={insp.kind}
                    canControl={canControl}
                    onStop={() => askStop(w)}
                    stopLabel={t('clusterActionStop')}
                    idleTitle={t('clusterLongRunning')}
                  />
                ))
              ) : (
                <span className="text-[12px] text-faint">{t('clusterNoWorkload')}</span>
              )}
            </div>
          ) : null}

          {/* Shared stores — their connection address where known. */}
          {insp.stores && insp.stores.length > 0 ? (
            <div className="space-y-1.5">
              <div className="text-[11px] uppercase tracking-wide text-faint">
                {t('clusterStores')}
              </div>
              <div className="divide-y divide-border rounded-lg border border-border">
                {insp.stores.map((s) => (
                  <div key={s.name} className="flex items-center gap-3 px-3 py-1.5">
                    <span className="size-1.5 shrink-0 rounded-[2px] bg-cyan-400" />
                    <span className="font-mono text-[12px]">{s.name}</span>
                    <span className="flex-1 truncate text-right font-mono text-[12px] text-muted-foreground">
                      {s.address ?? t('clusterAddressDynamic')}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {insp.warnings.length > 0 ? (
            <Callout tone="warning" className="py-1.5">
              {t('clusterWarnings', { warnings: insp.warnings.join('; ') })}
            </Callout>
          ) : null}
        </div>
      ) : null}

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

// Hero capacity donut — free eval slots as a fraction of total (indigo brand accent, distinct from node load colour).
function CapacityDonut({ free, total }: { free: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((free / total) * 100)) : 0
  const r = 30
  const c = 2 * Math.PI * r
  return (
    <svg width="72" height="72" viewBox="0 0 72 72" className="-rotate-90">
      <circle
        cx="36"
        cy="36"
        r={r}
        fill="none"
        strokeWidth="6"
        stroke="currentColor"
        className="text-muted-foreground/12"
      />
      <circle
        cx="36"
        cy="36"
        r={r}
        fill="none"
        strokeWidth="6"
        strokeLinecap="round"
        stroke="currentColor"
        className="text-primary transition-[stroke-dashoffset] duration-700 ease-out"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct / 100)}
      />
    </svg>
  )
}

// A labelled overview metric (big number + caption + one or more context chips).
function OverviewStat({
  value,
  label,
  chips,
  warn,
}: {
  value: ReactNode
  label: string
  chips?: string[]
  warn?: boolean
}) {
  return (
    <div>
      <div className="font-mono text-[18px] font-[560] leading-none tracking-tight">{value}</div>
      <div className="mt-1 text-[9.5px] uppercase tracking-[0.08em] text-faint">{label}</div>
      {chips && chips.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {chips.map((ch) => (
            <span
              key={ch}
              className={cn(
                'rounded border border-border px-1.5 py-px font-mono text-[10.5px] text-muted-foreground',
                warn && 'border-amber-500/25 text-amber-500'
              )}
            >
              {ch}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
