'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Check, Copy, Cpu, RefreshCw, Trash2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import type { Run } from '@/entities/run'
import { capabilityMeta, type RunnerMeta } from '@/entities/runner'
import { copyText } from '@/shared/lib/clipboard'
import {
  getEverdictDesktop,
  normalizeRunnersStatus,
  type DesktopRunnersStatus,
  type EverdictDesktopBridge,
} from '@/shared/lib/desktop-bridge'
import { fmtDateTime, fmtTimeAgo } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Card } from '@/shared/ui/card'
import { StatusPill } from '@/shared/ui/status-pill'

import { revokeRunnerFromDetailAction } from '../api/runner-detail'

// A runner refreshes lastSeenAt on every long-poll lease (~25s), so within 90s it counts as connected (roster convention).
const ONLINE_WINDOW_MS = 90_000
const isOnline = (lastSeenAt?: string): boolean =>
  lastSeenAt !== undefined && Date.now() - new Date(lastSeenAt).getTime() < ONLINE_WINDOW_MS
// Re-run the server component periodically so lastSeenAt / self-status / activity stay fresh while the page is open.
const REFRESH_MS = 12_000

// A self-hosted runner's detail — the runtime-detail-equivalent for a device that pulls jobs (visibility + recovery).
// scope decides which revoke path + target prefix applies; reconnect is only offered when THIS desktop holds the token.
export function RunnerDetail({
  runner,
  scope,
  target,
  activity,
  workspace,
  downloadHref,
}: {
  runner: RunnerMeta
  scope: 'personal' | 'workspace'
  target: string
  activity: Run[]
  workspace: string
  downloadHref: string
}) {
  const t = useTranslations('runnerDetail')
  const locale = useLocale()
  const router = useRouter()
  const [bridge, setBridge] = useState<EverdictDesktopBridge | null>(null)
  const [desktop, setDesktop] = useState<DesktopRunnersStatus | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string>()
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const [busy, startTransition] = useTransition()

  // Detect the desktop shell (after mount → no SSR mismatch) + subscribe to this device's live runner status.
  useEffect(() => {
    const b = getEverdictDesktop()
    if (!b) return
    setBridge(b)
    void b
      .runnerStatus()
      .then((s) => setDesktop(normalizeRunnersStatus(s)))
      .catch(() => {})
    return b.onRunnerStatus((s) => setDesktop(normalizeRunnersStatus(s)))
  }, [])

  // Live-ish: re-fetch the server component while the tab is visible so the online dot / self-status / activity update.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh()
    }, REFRESH_MS)
    return () => clearInterval(timer)
  }, [router])

  const online = isOnline(runner.lastSeenAt)
  // Is this runner paired to THIS device? Only then can the desktop bridge reconnect it (it holds the rnr_ token).
  const onThisDevice = (desktop?.runners ?? []).some((r) => r.paired && r.runnerId === runner.id)
  const canReconnect =
    bridge !== null && typeof bridge.reconnectRunner === 'function' && onThisDevice

  function onReconnect() {
    const reconnect = bridge?.reconnectRunner
    if (!bridge || typeof reconnect !== 'function') return
    setError(undefined)
    startTransition(async () => {
      try {
        await reconnect(runner.id)
        setDesktop(normalizeRunnersStatus(await bridge.runnerStatus()))
        router.refresh()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })
  }

  function onRevoke() {
    setError(undefined)
    startTransition(async () => {
      const r = await revokeRunnerFromDetailAction(runner.id, scope)
      if (!r.ok) {
        setError(r.error)
        return
      }
      if (bridge && onThisDevice) await bridge.unpairRunner(runner.id).catch(() => {})
      router.push(`/${workspace}/runtimes`)
    })
  }

  const meta: { label: string; value: React.ReactNode }[] = [
    {
      label: t('metaScope'),
      value: scope === 'workspace' ? t('scopeWorkspace') : t('scopePersonal'),
    },
    ...(runner.os ? [{ label: t('metaOs'), value: runner.os }] : []),
    ...(runner.version ? [{ label: t('metaVersion'), value: runner.version }] : []),
    { label: t('metaPaired'), value: fmtDateTime(runner.pairedAt) },
    {
      label: t('metaLastSeen'),
      value: runner.lastSeenAt ? fmtTimeAgo(runner.lastSeenAt, locale) : t('lastSeenNever'),
    },
  ]

  return (
    <div className="space-y-6">
      {error && <Callout tone="danger">{error}</Callout>}

      <Card className="space-y-4 p-5">
        {/* Header: online/offline + this-device + update-required, plus the recovery + revoke actions. */}
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[12px] font-[510]',
              online
                ? 'border-[var(--color-success)]/30 text-[var(--color-success)]'
                : 'border-border text-faint'
            )}
          >
            <span
              className={cn(
                'size-1.5 rounded-full',
                online ? 'bg-[var(--color-success)]' : 'bg-muted-foreground/40'
              )}
            />
            {online ? t('online') : t('offline')}
          </span>
          {onThisDevice && <Badge tone="info">{t('thisDevice')}</Badge>}
          {runner.updateRequired && <Badge tone="warning">{t('updateRequired')}</Badge>}
          <span className="flex-1" />
          {canReconnect && (
            <Button size="sm" variant="secondary" onClick={onReconnect} disabled={busy}>
              <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
              {t('reconnect')}
            </Button>
          )}
          {confirmRevoke ? (
            <span className="flex items-center gap-1.5">
              <span className="text-[12px] text-muted-foreground">{t('revokeConfirm')}</span>
              <Button size="sm" variant="destructive" onClick={onRevoke} disabled={busy}>
                {t('revokeYes')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmRevoke(false)}
                disabled={busy}
              >
                {t('cancel')}
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmRevoke(true)}
              disabled={busy}
            >
              <Trash2 className="size-3.5" />
              {t('revoke')}
            </Button>
          )}
        </div>

        {/* Self-reported live status (Phase 2) — what the runner is doing / why it can't do work, colored by severity. */}
        {runner.status && (
          <div
            className={cn(
              'rounded-lg border px-3 py-2 text-[13px]',
              runner.status.level === 'error'
                ? 'border-destructive/30 text-destructive'
                : runner.status.level === 'warn'
                  ? 'border-[var(--color-warning)]/30 text-[var(--color-warning)]'
                  : 'border-border text-muted-foreground'
            )}
          >
            <span className="font-[510]">{t('selfStatus')}</span> {runner.status.text}
          </div>
        )}

        {/* Meta strip — scope / os / version / paired / last-seen + the runtime target. */}
        <div className="space-y-2 border-t border-border pt-4 text-[13px]">
          {meta.map((m) => (
            <div key={m.label} className="flex gap-4">
              <span className="w-[128px] shrink-0 text-muted-foreground">{m.label}</span>
              <span className="break-all">{m.value}</span>
            </div>
          ))}
          {/* How to use — the runtime target a run points at. */}
          <div className="flex items-center gap-4">
            <span className="w-[128px] shrink-0 text-muted-foreground">{t('metaTarget')}</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[12px]">{target}</code>
            <button
              type="button"
              onClick={() =>
                void copyText(target, undefined, locale).then((ok) => ok && setCopied(true))
              }
              className="inline-flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? t('copied') : t('copy')}
            </button>
          </div>
        </div>

        {/* Capabilities — what this machine can run (self-probed, refreshed on each lease). */}
        <div className="border-t border-border pt-4">
          <p className="mb-2 text-[12px] font-[510] text-muted-foreground">{t('capabilities')}</p>
          <div className="flex flex-wrap gap-1.5">
            {capabilityMeta.map((c) => {
              const has = runner.capabilities.includes(c.name)
              return (
                <span
                  key={c.name}
                  className={cn(
                    'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px]',
                    has
                      ? 'border-[var(--color-success)]/30 text-[var(--color-success)]'
                      : 'border-border text-faint line-through'
                  )}
                >
                  {c.label}
                </span>
              )
            })}
          </div>
        </div>
      </Card>

      {/* Recovery — shown when offline (hide-empty convention keeps it out of the way when healthy). */}
      {!online && (
        <Card className="space-y-3 p-5">
          <p className="text-[13px] font-[560] text-foreground">{t('offlineTitle')}</p>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {canReconnect
              ? t('offlineReconnectHint')
              : onThisDevice
                ? t('offlineOpenDesktopHint')
                : scope === 'workspace'
                  ? t('offlineWorkspaceHint')
                  : t('offlinePersonalHint')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {canReconnect ? (
              <Button size="sm" onClick={onReconnect} disabled={busy}>
                <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} />
                {t('reconnect')}
              </Button>
            ) : (
              <Link
                href={downloadHref}
                className="inline-flex items-center gap-1.5 text-[13px] font-[510] text-link transition-colors hover:underline"
              >
                {t('getDesktop')}
              </Link>
            )}
          </div>
        </Card>
      )}

      {/* Activity — the recent runs this runner executed (provenance), newest first. */}
      <div className="space-y-2.5">
        <p className="text-[13px] font-[560] text-foreground">{t('activityTitle')}</p>
        {activity.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t('activityEmpty')}</p>
        ) : (
          <Card className="divide-y divide-border">
            {activity.map((r) => (
              <Link
                key={r.id}
                href={`/${workspace}/runs/${encodeURIComponent(r.id)}`}
                className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-elevated"
              >
                <Cpu className="size-3.5 shrink-0 text-faint" />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{r.caseId}</span>
                <span className="hidden shrink-0 text-[12px] text-muted-foreground sm:inline">
                  {r.harness.id}@{r.harness.version}
                </span>
                <span className="w-[92px] shrink-0 text-right text-[11px] text-faint">
                  {fmtTimeAgo(r.createdAt, locale)}
                </span>
                <StatusPill status={r.status} />
              </Link>
            ))}
          </Card>
        )}
      </div>
    </div>
  )
}
