'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { Download, Laptop, Trash2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import {
  capabilityMeta,
  runnerCapabilitySchema,
  type RunnerCapability,
  type RunnerMeta,
} from '@/entities/runner'
import {
  getEverdictDesktop,
  normalizeRunnersStatus,
  type DesktopRunnersStatus,
  type EverdictDesktopBridge,
} from '@/shared/lib/desktop-bridge'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button, buttonVariants } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'

import { pairRunnerAction, revokeRunnerAction } from '../api/manage-runners'

// Online check — a runner refreshes lastSeenAt on every long-poll lease (~25s), so within 90s it counts as connected.
// (Evaluated at page-load time — not updated in real time.)
const ONLINE_WINDOW_MS = 90_000
function isOnline(lastSeenAt?: string): boolean {
  return lastSeenAt !== undefined && Date.now() - new Date(lastSeenAt).getTime() < ONLINE_WINDOW_MS
}

function isRunnerCapability(value: string): value is RunnerCapability {
  return runnerCapabilitySchema.safeParse(value).success
}

// Runners are personally owned (self-scoped by subject) — no role gate.
// The desktop app owns the pairing surface (one-click; design D7): the browser doesn't offer manual pairing
// (token shown once) and only lists/shows live status/revokes — instead it suggests the desktop download. A headless
// server uses an API key to `POST /runners` → `everdict runner --pair` (docs/architecture/self-hosted-runner.md).
// A device can be paired as SEVERAL independent runners (D9) — the desktop supervises them; each is its own row here.
export function RunnersManager({
  runners,
  downloadHref,
}: {
  runners: RunnerMeta[]
  downloadHref: string // /{workspace}/download — desktop download page for browser users
}) {
  const t = useTranslations('manageRunners')
  const locale = useLocale()
  const [confirmId, setConfirmId] = useState<string>()
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()
  // Detect the desktop shell — if the bridge exists, enable one-click pairing + this device's live status (only after mount; avoids SSR mismatch).
  const [bridge, setBridge] = useState<EverdictDesktopBridge | null>(null)
  const [desktop, setDesktop] = useState<DesktopRunnersStatus | null>(null)
  const [cpuCount, setCpuCount] = useState(0) // this device's logical cores — the soft-cap reference (D9)

  useEffect(() => {
    const b = getEverdictDesktop()
    if (!b) return
    setBridge(b)
    void b
      .appInfo()
      .then((i) => setCpuCount(i.cpuCount ?? 0))
      .catch(() => {})
    void b
      .runnerStatus()
      .then((s) => setDesktop(normalizeRunnersStatus(s)))
      .catch(() => {})
    return b.onRunnerStatus((s) => setDesktop(normalizeRunnersStatus(s)))
  }, [])

  // Runners paired on THIS device (from the live bridge), and the set of their ids for row matching.
  const deviceRunners = (desktop?.runners ?? []).filter((r) => r.paired)
  const deviceRunnerIds = new Set(
    deviceRunners.map((r) => r.runnerId).filter((id): id is string => id !== undefined)
  )
  const deviceCount = deviceRunners.length
  // Soft cap (D9): warn — but never block — once this device hosts at least as many runners as it has cores.
  const overSoftCap = cpuCount > 0 && deviceCount >= cpuCount
  // Local pairings on this device that are no longer in the account roster (revoked on the server, or another account).
  const staleLocal = deviceRunners.filter(
    (d) => d.runnerId !== undefined && !runners.some((r) => r.id === d.runnerId)
  )

  function onRevoke(id: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await revokeRunnerAction(id)
      setConfirmId(undefined)
      if (!r.ok) {
        setError(r.error)
        return
      }
      // If we revoked a runner paired to THIS device, also clean up its desktop-side token (the server revoke is authoritative — ignore bridge failures).
      if (bridge && deviceRunnerIds.has(id)) await bridge.unpairRunner(id).catch(() => {})
    })
  }

  // Clean up local pairings that no longer exist server-side — discard their desktop-side tokens.
  function onCleanupStale() {
    const b = bridge
    if (!b) return
    startTransition(async () => {
      for (const d of staleLocal) if (d.runnerId) await b.unpairRunner(d.runnerId).catch(() => {})
      setDesktop(normalizeRunnersStatus(await b.runnerStatus().catch(() => ({ runners: [] }))))
    })
  }

  // One-click — mint a NEW runner and hand its token down via the bridge only (never shown). Additive: each click adds one more
  // runner on this device (D9), labeled with a suffix so several runners on one host stay distinguishable.
  function onConnectThisDevice() {
    const b = bridge
    if (!b) return
    setError(undefined)
    startTransition(async () => {
      try {
        const info = await b.appInfo()
        const caps = info.capabilities.filter(isRunnerCapability)
        const label = deviceCount === 0 ? info.hostname : `${info.hostname} #${deviceCount + 1}`
        const r = await pairRunnerAction({
          label,
          os: info.platform,
          ...(caps.length > 0 ? { capabilities: caps } : {}),
        })
        if (!r.ok || !r.token) {
          setError(r.error ?? t('connectFailed'))
          return
        }
        await b.pairRunner({
          token: r.token,
          ...(r.runner ? { runnerId: r.runner.id } : {}),
          ...(r.apiUrl ? { apiUrl: r.apiUrl } : {}),
        })
        setDesktop(normalizeRunnersStatus(await b.runnerStatus()))
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })
  }

  const connectLabel = pending
    ? t('connecting')
    : deviceCount === 0
      ? t('connectThisDevice')
      : t('connectAnother')

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <p className="text-[13px] text-muted-foreground">{t('ownedByYou')}</p>
        <span className="flex shrink-0 items-center gap-2">
          {/* The desktop owns the pairing surface (D7) — the browser shows only a download CTA. Connecting is additive (D9). */}
          {bridge && (
            <Button size="sm" onClick={onConnectThisDevice} disabled={pending}>
              <Laptop />
              {connectLabel}
            </Button>
          )}
          {!bridge && (
            <Link href={downloadHref} className={buttonVariants({ size: 'sm' })}>
              <Download />
              {t('getDesktopApp')}
            </Link>
          )}
        </span>
      </div>

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}

      {/* Soft cap (D9): more runners than cores may slow this PC — warn, but pairing stays allowed. */}
      {bridge && overSoftCap && (
        <Callout tone="warning" className="py-1.5">
          {t('softCapWarning', { cpus: cpuCount })}
        </Callout>
      )}

      {/* Stale local pairings: this device holds runner tokens no longer in the roster (revoked/another account). Offer to clean them up. */}
      {bridge && staleLocal.length > 0 && (
        <Callout tone="warning">
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span>{t('staleLocalWarning', { count: staleLocal.length })}</span>
            <Button size="xs" variant="secondary" onClick={onCleanupStale} disabled={pending}>
              <Laptop />
              {t('cleanUpStale')}
            </Button>
          </span>
        </Callout>
      )}

      {runners.length === 0 ? (
        <EmptyState
          icon={<Laptop strokeWidth={1.75} />}
          title={t('emptyTitle')}
          hint={bridge ? t('emptyHintBridge') : t('emptyHintDownload')}
          action={
            bridge ? (
              <Button size="sm" onClick={onConnectThisDevice} disabled={pending}>
                <Laptop />
                {pending ? t('connecting') : t('connectThisDevice')}
              </Button>
            ) : (
              <Link
                href={downloadHref}
                className={buttonVariants({ size: 'sm', variant: 'secondary' })}
              >
                <Download />
                {t('getDesktopApp')}
              </Link>
            )
          }
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border bg-card shadow-raise">
          {runners.map((r) => {
            // For a runner paired to this device, use the bridge's live status instead of the lastSeenAt estimate.
            const live = deviceRunners.find((d) => d.runnerId === r.id)
            const thisDevice = live !== undefined
            const online = live ? live.state !== 'off' : isOnline(r.lastSeenAt)
            // Capabilities also prefer live — if the docker daemon stopped after pairing, it's reflected immediately.
            const caps = live && live.capabilities.length > 0 ? live.capabilities : r.capabilities
            const statusText = live
              ? live.state === 'running'
                ? t('running', { count: live.activeJobs })
                : live.state === 'idle'
                  ? t('online')
                  : t('offline')
              : online
                ? t('online')
                : t('offline')
            return (
              <li key={r.id} className="flex items-center gap-3 px-3.5 py-3">
                <span className="relative grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground">
                  <Laptop className="size-4" strokeWidth={1.75} />
                  {/* Connection status dot — bottom-right */}
                  <span
                    className={cn(
                      'absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card',
                      online ? 'bg-[var(--color-success)]' : 'bg-muted-foreground/40'
                    )}
                    title={online ? t('online') : t('offline')}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13px] font-[510] text-foreground">
                      {r.label}
                    </span>
                    {thisDevice && <Badge>{t('thisDevice')}</Badge>}
                    <span
                      className={cn(
                        'text-[12px]',
                        online ? 'text-[var(--color-success)]' : 'text-faint'
                      )}
                    >
                      {statusText}
                    </span>
                    {r.os && <Badge tone="outline">{r.os}</Badge>}
                  </div>
                  {/* Capability self-labels — green (supported)/grey (unsupported). The runner probes its own machine and advertises them. */}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    {capabilityMeta.map(({ name, label }) => {
                      const has = caps.includes(name)
                      return (
                        <Badge
                          key={name}
                          tone={has ? 'success' : 'outline'}
                          className={has ? undefined : 'opacity-55'}
                          title={has ? t('capSupported') : t('capUnsupported')}
                        >
                          {has ? '✓ ' : ''}
                          {label}
                        </Badge>
                      )
                    })}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-faint">
                    <span>
                      {t('pairedAt', { date: new Date(r.pairedAt).toLocaleString(locale) })}
                    </span>
                    {r.lastSeenAt && (
                      <>
                        <span>·</span>
                        <span>
                          {t('lastSeenAt', {
                            date: new Date(r.lastSeenAt).toLocaleString(locale),
                          })}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                {confirmId === r.id ? (
                  <span className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="destructive"
                      size="xs"
                      disabled={pending}
                      onClick={() => onRevoke(r.id)}
                    >
                      {t('revokeConfirm')}
                    </Button>
                    <button
                      type="button"
                      className="text-[12px] text-muted-foreground hover:text-foreground"
                      onClick={() => setConfirmId(undefined)}
                    >
                      {t('close')}
                    </button>
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={t('revokeRunnerAria', { name: r.label })}
                    onClick={() => setConfirmId(r.id)}
                  >
                    <Trash2 />
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
