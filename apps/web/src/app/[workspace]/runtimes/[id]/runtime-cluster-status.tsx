'use client'

import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react'
import {
  Ban,
  HardDrive,
  Loader2,
  Play,
  RefreshCw,
  Server,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
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
import { Input, Label } from '@/shared/ui/input'

type InspectNode = NonNullable<RuntimeInspection['nodes']>['items'][number]
type InspectWorkload = NonNullable<RuntimeInspection['workload']>[number]

// A running/pending unit older than this reads as an idle-reclaim candidate. Stores are long-lived by design, so they're excluded.
const LONG_RUNNING_SECONDS = 30 * 60
// The detail screen keeps the cluster view live — it reloads on entry and re-polls the cluster on this cadence.
const CLUSTER_REFRESH_MS = 20_000

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
  if (g < 1024) return `${g % 1 === 0 ? g : g.toFixed(1)} GiB`
  const t = g / 1024
  return `${t % 1 === 0 ? t : t.toFixed(1)} TiB`
}
const idleUnit = (w: InspectWorkload) =>
  w.role !== 'store' && (w.ageSeconds ?? 0) >= LONG_RUNNING_SECONDS
// An external (non-everdict) service co-resident on the cluster — targeted for control by its namespace.
const isExternal = (w: InspectWorkload) => w.role === 'other'
// Which units expose a resize control: stores never; K8s only external units (eval Jobs can't be resized), Nomad
// any non-store single-task unit (the backend refuses a multi-task job with a clear error).
const canResizeUnit = (w: InspectWorkload, kind: string) =>
  w.role !== 'store' && (kind === 'k8s' ? isExternal(w) : true)

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

// One workload as a role-coloured chip with a hover tooltip (role/ns/owner/status/age/resources) + inline controls:
// stop/terminate for non-store units, and a resize button where the unit supports it. An external (role 'other')
// unit carries an "external" badge so it reads distinctly from the everdict eval/store units on the same node.
function WorkloadChip({
  w,
  kind,
  canControl,
  onStop,
  onResize,
  stopLabel,
  resizeLabel,
  externalLabel,
  idleTitle,
  nsLabel,
  ownerLabel,
}: {
  w: InspectWorkload
  kind: string
  canControl: boolean
  onStop: () => void
  onResize: () => void
  stopLabel: string
  resizeLabel: string
  externalLabel: string
  idleTitle: string
  nsLabel: string
  ownerLabel: string
}) {
  const idle = idleUnit(w)
  const external = isExternal(w)
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
      {external ? (
        <span className="shrink-0 rounded border border-border px-1 py-px text-[8.5px] font-[600] uppercase tracking-wide text-faint">
          {externalLabel}
        </span>
      ) : null}
      {/* The controls reserve their space and only toggle visibility on hover — the chip's width must never change
          with hover. In a full flex-wrap row a hover-widened chip wraps to the next line, the pointer leaves it,
          it un-wraps back under the pointer, and the layout oscillates forever. */}
      {canControl && canResizeUnit(w, kind) ? (
        <button
          type="button"
          title={resizeLabel}
          onClick={onResize}
          className="invisible grid size-4 place-items-center rounded text-faint transition-colors hover:bg-primary/10 hover:text-primary group-hover:visible"
        >
          <SlidersHorizontal className="size-2.5" />
        </button>
      ) : null}
      {canControl && w.role !== 'store' ? (
        <button
          type="button"
          title={stopLabel}
          onClick={onStop}
          className="invisible grid size-4 place-items-center rounded text-faint transition-colors hover:bg-rose-500/10 hover:text-rose-500 group-hover:visible"
        >
          <X className="size-2.5" />
        </button>
      ) : null}
      <span className="pointer-events-none absolute bottom-[calc(100%+7px)] left-1/2 z-20 w-max max-w-[220px] -translate-x-1/2 translate-y-1 space-y-1 rounded-lg border border-border-strong bg-popover p-2 opacity-0 shadow-pop transition-all duration-150 group-hover:translate-y-0 group-hover:opacity-100">
        <TipRow k="role" v={<span className={tv}>{external ? externalLabel : w.role}</span>} />
        {w.namespace ? <TipRow k={nsLabel} v={w.namespace} /> : null}
        {w.ownerKind ? <TipRow k={ownerLabel} v={w.ownerKind} /> : null}
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
  const [resizing, setResizing] = useState<InspectWorkload>()
  const [actionMessage, setActionMessage] = useState<string>()
  const [running, startAction] = useTransition()

  // A poll must not fire while the user is mid-action (confirm modal open / resize modal open / control running) or
  // a fetch is already in flight; the ref keeps the interval callback reading the latest flags without re-arming.
  const busyRef = useRef(false)
  busyRef.current = loading || running || pending !== undefined || resizing !== undefined

  // Manual refresh (button) — unlike the first load it keeps the current view on screen while re-fetching (no flicker).
  function refresh() {
    setActionMessage(undefined)
    start(async () => setResult(await inspectRuntimeAction(id, version)))
  }

  // Load on entering the detail screen, then keep the view live by re-polling the cluster on a cadence. The poll pauses
  // while the tab is hidden or the user is mid-action, and never stacks a second fetch on an in-flight one.
  useEffect(() => {
    let cancelled = false
    const tick = () => {
      if (cancelled || busyRef.current || (typeof document !== 'undefined' && document.hidden))
        return
      start(async () => {
        const r = await inspectRuntimeAction(id, version)
        if (!cancelled) setResult(r)
      })
    }
    tick()
    const iv = setInterval(tick, CLUSTER_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [id, version, start])

  // Run a control command, surface its outcome, and re-inspect. Shared by the confirm modal and the resize modal.
  function runCommand(command: RuntimeControlCommand) {
    startAction(async () => {
      const r = await controlRuntimeAction(id, version, command)
      setPending(undefined)
      setResizing(undefined)
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
            : res?.detail !== undefined
              ? t('clusterResized', { detail: res.detail })
              : t('clusterActionDone')
      )
      setResult(await inspectRuntimeAction(id, version)) // refresh
    })
  }

  function confirmRun() {
    if (pending) runCommand(pending.command)
  }

  const insp: RuntimeInspection | undefined = result?.ok ? result.inspection : undefined

  // An external unit terminate carries its namespace (targets the pod's owning controller / the namespaced job) and
  // reads as a "terminate a service", distinct from aborting an everdict eval.
  const askStop = (w: InspectWorkload) =>
    setPending(
      isExternal(w)
        ? {
            command: {
              action: 'stopWorkload',
              name: w.name,
              ...(w.namespace ? { namespace: w.namespace } : {}),
            },
            title: t('clusterActionTerminate'),
            body: t('clusterConfirmTerminate', { name: w.name, namespace: w.namespace ?? '' }),
          }
        : {
            command: { action: 'stopWorkload', name: w.name },
            title: t('clusterActionStop'),
            body: t('clusterConfirmStop', { name: w.name }),
          }
    )
  const askCordon = (n: InspectNode) =>
    setPending({
      command: { action: 'cordonNode', node: n.name, schedulable: !n.schedulable },
      title: n.schedulable ? t('clusterActionCordon') : t('clusterActionUncordon'),
      body: n.schedulable
        ? t('clusterConfirmCordon', { node: n.name })
        : t('clusterConfirmUncordon', { node: n.name }),
    })

  // One chip renderer shared by every workload list (node cards / unscheduled / degraded fallback), so the control
  // wiring + labels stay in one place. kind is passed explicitly (the reachable-block narrowing doesn't reach here).
  const chip = (w: InspectWorkload, kind: string) => (
    <WorkloadChip
      key={w.id}
      w={w}
      kind={kind}
      canControl={canControl}
      onStop={() => askStop(w)}
      onResize={() => setResizing(w)}
      stopLabel={isExternal(w) ? t('clusterActionTerminate') : t('clusterActionStop')}
      resizeLabel={t('clusterActionResize')}
      externalLabel={t('clusterExternal')}
      idleTitle={t('clusterLongRunning')}
      nsLabel={t('clusterTipNamespace')}
      ownerLabel={t('clusterTipOwner')}
    />
  )

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
  const externalCount = workloads.filter(isExternal).length
  const idleCount = workloads.filter(idleUnit).length
  const reclaimable = canControl && workloads.some((w) => w.role === 'eval')

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-[510]">
          <Server className="size-3.5 text-muted-foreground" />
          {t('clusterStatus')}
          {/* Live badge — the view auto-refreshes on a cadence; a soft pulse signals it's kept current. */}
          <span className="ml-1 inline-flex items-center gap-1 text-[10.5px] font-normal text-faint">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
            {t('clusterLive', { seconds: CLUSTER_REFRESH_MS / 1000 })}
          </span>
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
            onClick={refresh}
            disabled={loading}
            className="gap-1.5"
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {t('clusterRefresh')}
          </Button>
        </div>
      </div>

      {/* First load on entering the screen — nothing to show yet, so a lightweight loading line stands in. */}
      {loading && !result ? (
        <div className="flex items-center gap-2 py-2 text-[12px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          {t('clusterLoading')}
        </div>
      ) : null}

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
                chips={[
                  t('clusterEvalStore', { eval: evalCount, store: storeCount }),
                  ...(externalCount > 0
                    ? [t('clusterExternalCount', { count: externalCount })]
                    : []),
                ]}
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

                    <NodeMetaStrip node={n} t={t} />

                    {n.cpuTotal !== undefined ||
                    n.memoryMbTotal !== undefined ||
                    n.diskMbTotal !== undefined ? (
                      <div className="flex flex-wrap gap-4">
                        {n.cpuTotal !== undefined ? (
                          <RadialGauge
                            label={t('clusterCpu')}
                            // Real node load (all workloads on the node) when the cluster reports it; otherwise fall
                            // back to the sum of the everdict units we can see (understates a node shared with other work).
                            used={n.cpuUsed ?? sum(units, 'cpu')}
                            total={n.cpuTotal}
                            render={(v) => formatCpu(v, insp.kind)}
                          />
                        ) : null}
                        {n.memoryMbTotal !== undefined ? (
                          <RadialGauge
                            label={t('clusterMemory')}
                            used={n.memoryMbUsed ?? sum(units, 'memoryMb')}
                            total={n.memoryMbTotal}
                            render={formatMem}
                          />
                        ) : null}
                        {n.diskMbTotal !== undefined && n.diskMbUsed !== undefined ? (
                          <RadialGauge
                            label={t('clusterDisk')}
                            used={n.diskMbUsed}
                            total={n.diskMbTotal}
                            render={formatMem}
                          />
                        ) : null}
                      </div>
                    ) : null}

                    {/* A disk total with no usage figure (only the capacity is known) — show it as a plain line. */}
                    {n.diskMbTotal !== undefined && n.diskMbUsed === undefined ? (
                      <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
                        <HardDrive className="size-3 text-faint" />
                        {t('clusterDisk')}: {formatMem(n.diskMbTotal)}
                      </div>
                    ) : null}

                    <div className="flex flex-wrap gap-1.5">
                      {units.length > 0 ? (
                        units.map((w) => chip(w, insp.kind))
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
                  {unscheduled.map((w) => chip(w, insp.kind))}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Fallback flat list when node listing degraded. */}
          {!insp.nodes && insp.workload ? (
            <div className="flex flex-wrap gap-1.5">
              {insp.workload.length > 0 ? (
                insp.workload.map((w) => chip(w, insp.kind))
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
        className="max-w-md"
      >
        <div className="space-y-4 p-5">
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

      {/* Resize modal — needs input, so it's separate from the confirm modal. Prefilled from the unit's current ask. */}
      {resizing ? (
        <ResizeDialog
          unit={resizing}
          kind={insp?.kind ?? ''}
          running={running}
          onCancel={() => setResizing(undefined)}
          onSubmit={(cpu, memoryMb) =>
            runCommand({
              action: 'resizeWorkload',
              name: resizing.name,
              ...(resizing.namespace ? { namespace: resizing.namespace } : {}),
              ...(cpu !== undefined ? { cpu } : {}),
              ...(memoryMb !== undefined ? { memoryMb } : {}),
            })
          }
          t={t}
        />
      ) : null}
    </div>
  )
}

// A compact identity strip under a node's name — OS / arch, container-runtime + node-agent versions, IP. Only the
// fields the cluster actually reported render (all best-effort); an empty strip collapses to nothing.
function NodeMetaStrip({ node, t }: { node: InspectNode; t: ReturnType<typeof useTranslations> }) {
  const rows: Array<{ k: string; v: string }> = []
  if (node.os)
    rows.push({ k: t('clusterNodeOs'), v: node.arch ? `${node.os} · ${node.arch}` : node.os })
  else if (node.arch) rows.push({ k: t('clusterNodeArch'), v: node.arch })
  if (node.kernel) rows.push({ k: t('clusterNodeKernel'), v: node.kernel })
  if (node.containerRuntime) rows.push({ k: t('clusterNodeRuntime'), v: node.containerRuntime })
  if (node.agentVersion) rows.push({ k: t('clusterNodeAgent'), v: node.agentVersion })
  if (node.address) rows.push({ k: t('clusterNodeIp'), v: node.address })
  if (rows.length === 0) return null
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {rows.map((r) => (
        <span key={r.k} className="inline-flex items-baseline gap-1 text-[10.5px]">
          <span className="uppercase tracking-wide text-faint">{r.k}</span>
          <span className="font-mono text-muted-foreground">{r.v}</span>
        </span>
      ))}
    </div>
  )
}

// The resize form — CPU + memory in the runtime's native units (Nomad MHz / K8s millicores; memory MiB), prefilled
// from the unit's current ask. Submit is blocked until at least one field carries a positive number.
function ResizeDialog({
  unit,
  kind,
  running,
  onCancel,
  onSubmit,
  t,
}: {
  unit: InspectWorkload
  kind: string
  running: boolean
  onCancel: () => void
  onSubmit: (cpu: number | undefined, memoryMb: number | undefined) => void
  t: ReturnType<typeof useTranslations>
}) {
  const [cpu, setCpu] = useState(unit.cpu !== undefined ? String(unit.cpu) : '')
  const [memoryMb, setMemoryMb] = useState(unit.memoryMb !== undefined ? String(unit.memoryMb) : '')
  const cpuNum = cpu.trim() === '' ? undefined : Number(cpu)
  const memNum = memoryMb.trim() === '' ? undefined : Number(memoryMb)
  const cpuValid = cpuNum === undefined || (Number.isFinite(cpuNum) && cpuNum > 0)
  const memValid = memNum === undefined || (Number.isFinite(memNum) && memNum > 0)
  const hasValue = cpuNum !== undefined || memNum !== undefined
  const valid = cpuValid && memValid && hasValue
  return (
    <Dialog open onClose={() => (running ? undefined : onCancel())} className="max-w-[26rem]">
      <div className="space-y-4 p-5">
        <h3 className="text-[14px] font-[560]">{t('clusterResizeTitle', { name: unit.name })}</h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {t('clusterResizeBody')}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="resize-cpu">
              {kind === 'k8s' ? t('clusterResizeCpuMilli') : t('clusterResizeCpuMhz')}
            </Label>
            <Input
              id="resize-cpu"
              inputMode="numeric"
              value={cpu}
              onChange={(e) => setCpu(e.target.value)}
              className={cn(!cpuValid && 'border-rose-500')}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="resize-mem">{t('clusterResizeMemory')}</Label>
            <Input
              id="resize-mem"
              inputMode="numeric"
              value={memoryMb}
              onChange={(e) => setMemoryMb(e.target.value)}
              className={cn(!memValid && 'border-rose-500')}
            />
          </div>
        </div>
        {!hasValue ? (
          <p className="text-[11.5px] text-faint">{t('clusterResizeNeedsValue')}</p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={running}>
            {t('clusterCancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => onSubmit(cpuNum, memNum)}
            disabled={running || !valid}
            className="gap-1.5"
          >
            {running ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t('clusterResizeSubmit')}
          </Button>
        </div>
      </div>
    </Dialog>
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
