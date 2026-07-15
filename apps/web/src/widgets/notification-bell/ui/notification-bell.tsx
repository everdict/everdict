'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, BellOff, BellRing, Check } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import { notificationsResponseSchema, type NotificationItem } from '@/entities/notification'
import {
  desktopHasPairedRunner,
  getEverdictDesktop,
  normalizeRunnersStatus,
} from '@/shared/lib/desktop-bridge'
import { fmtTimeAgo } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { DropdownItem, DropdownLabel, DropdownMenu } from '@/shared/ui/dropdown-menu'

// Notification bell (sidebar) — personal feed inbox. docs/architecture/notifications.md:
// Polls /api/notifications (BFF proxy) (25s + window focus), and fires new unread items as standard Web Notifications
// (N1 — in the desktop shell Electron routes these to OS notifications; fires only when the window is hidden to avoid noise).
const POLL_MS = 25_000
const NATIVE_FIRE_CAP = 3 // max native notifications fired per poll (flood prevention)

// Resource type → detail path segment (a schedule has no detail, so → edit). Comment-mention links use this mapping to reach the detail.
const RESOURCE_PATH: Record<string, (id: string) => string> = {
  dataset: (id) => `datasets/${id}`,
  harness: (id) => `harnesses/${id}`,
  scorecard: (id) => `scorecards/${id}`,
  view: (id) => `views/${id}`,
  schedule: (id) => `schedules/${id}/edit`,
  run: (id) => `runs/${id}`,
  runtime: (id) => `runtimes/${id}`,
}

function hrefOf(workspace: string, n: NotificationItem): string {
  if (n.link?.runId) return `/${workspace}/runs/${n.link.runId}`
  if (n.link?.scorecardId) return `/${workspace}/scorecards/${n.link.scorecardId}`
  // Resource comment mention — resourceType→path mapping, with a commentId anchor to scroll to that comment.
  if (n.link?.resourceType && n.link?.resourceId) {
    const seg = RESOURCE_PATH[n.link.resourceType]?.(encodeURIComponent(n.link.resourceId))
    if (seg) return `/${workspace}/${seg}${n.link.commentId ? `#comment-${n.link.commentId}` : ''}`
  }
  return `/${workspace}`
}

type Permission = NotificationPermission | 'unsupported'

// User's native-notification preference (off/on) — a local switch separate from the browser permission. Default on.
const NATIVE_PREF_KEY = 'everdict:native-notifications'
type NativePref = 'on' | 'off'

// Permission × preference → the derived status used by the status icon/dropdown.
type NativeStatus = 'on' | 'off' | 'needs-permission' | 'blocked'
function nativeStatusOf(permission: Permission, pref: NativePref): NativeStatus {
  if (permission === 'denied') return 'blocked'
  if (permission === 'default') return 'needs-permission'
  return pref === 'on' ? 'on' : 'off'
}
const NATIVE_STATUS_KEY: Record<NativeStatus, string> = {
  on: 'statusOn',
  off: 'statusOff',
  'needs-permission': 'statusNeedsPermission',
  blocked: 'statusBlocked',
}

export function NotificationBell({ workspace }: { workspace: string }) {
  const t = useTranslations('notificationBell')
  const locale = useLocale()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationItem[]>([])
  const [permission, setPermission] = useState<Permission>('unsupported')
  const [pref, setPref] = useState<NativePref>('on')
  const prefRef = useRef<NativePref>('on') // ref to read the latest preference from the polling closure
  const seeded = useRef(false) // the first-load batch is not a native-fire target (avoids a flood of past notifications right at app start)
  const seen = useRef<Set<string>>(new Set())
  // In the desktop shell + runner pairing, yield native firing to the main-process watcher (N6, web-session-independent) — dedup.
  const desktopHandlesNative = useRef(false)
  const cleanupBridge = useRef<(() => void) | null>(null)

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications?limit=30', { cache: 'no-store' })
      if (!res.ok) return
      const parsed = notificationsResponseSchema.safeParse(await res.json())
      if (!parsed.success) return
      const list = parsed.data.notifications
      const fresh = list.filter((n) => n.readAt === undefined && !seen.current.has(n.id))
      for (const n of list) seen.current.add(n.id)
      setItems(list)
      // Native firing — only when the window is not visible (a visible tab is served by the badge). The core path for desktop (tray-resident).
      if (
        seeded.current &&
        document.hidden &&
        !desktopHandlesNative.current &&
        prefRef.current === 'on' &&
        typeof Notification !== 'undefined' &&
        Notification.permission === 'granted'
      ) {
        for (const n of fresh.slice(0, NATIVE_FIRE_CAP)) {
          const note = new Notification(n.title, { ...(n.body ? { body: n.body } : {}), tag: n.id })
          note.onclick = () => {
            window.focus()
            router.push(hrefOf(workspace, n))
          }
        }
      }
      seeded.current = true
    } catch {
      // Polling failure is silent — retry on the next cycle.
    }
  }, [router, workspace])

  useEffect(() => {
    const bridge = getEverdictDesktop()
    if (bridge) {
      // The desktop owns native OS notifications while ≥1 runner is paired (any of this device's runners, D9).
      void bridge
        .runnerStatus()
        .then((s) => {
          desktopHandlesNative.current = desktopHasPairedRunner(normalizeRunnersStatus(s))
        })
        .catch(() => {})
      // Unsubscription happens in the cleanup below, together with the polling timer.
      const off = bridge.onRunnerStatus((s) => {
        desktopHandlesNative.current = desktopHasPairedRunner(normalizeRunnersStatus(s))
      })
      cleanupBridge.current = off
    }
    setPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
    const stored = localStorage.getItem(NATIVE_PREF_KEY) === 'off' ? 'off' : 'on'
    setPref(stored)
    prefRef.current = stored
    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    const onFocus = () => void poll()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      cleanupBridge.current?.()
      cleanupBridge.current = null
    }
  }, [poll])

  const unread = items.filter((n) => n.readAt === undefined).length

  async function markRead(payload: { ids?: string[]; all?: boolean }) {
    await fetch('/api/notifications/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {})
    void poll()
  }

  function onItemClick(n: NotificationItem) {
    if (n.readAt === undefined) void markRead({ ids: [n.id] })
    setOpen(false)
    router.push(hrefOf(workspace, n))
  }

  async function enableNative() {
    if (typeof Notification === 'undefined') return
    const p = await Notification.requestPermission()
    setPermission(p)
    if (p === 'granted') applyPref('on')
  }

  function applyPref(next: NativePref) {
    setPref(next)
    prefRef.current = next
    localStorage.setItem(NATIVE_PREF_KEY, next)
  }

  return (
    <div className="relative">
      {/* 아이콘 전용 트리거(오른쪽 상단 클러스터용) — 미읽음 개수는 코너 배지로. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('bellAria', { unread })}
        className={cn(
          'relative grid size-8 place-items-center rounded-md transition-colors',
          open
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        )}
      >
        {unread > 0 ? (
          <BellRing className="size-[18px] text-primary" strokeWidth={1.75} />
        ) : (
          <Bell className="size-[18px]" strokeWidth={1.75} />
        )}
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 grid min-w-[15px] place-items-center rounded-full bg-primary px-1 text-[10px] font-[560] leading-[15px] text-primary-foreground">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Close on outside click */}
          <button
            type="button"
            aria-label={t('closeBell')}
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-full z-50 mt-1 w-[320px] rounded-lg border border-border bg-card shadow-pop">
            {/* Header — controls only, no title: native-notification status icon (click → status-change dropdown) + mark all read. */}
            <div className="flex items-center justify-end gap-1 border-b border-border px-2 py-1.5">
              {unread > 0 && (
                <button
                  type="button"
                  onClick={() => void markRead({ all: true })}
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Check className="size-3.5" />
                  {t('markAllRead')}
                </button>
              )}
              {permission !== 'unsupported' &&
                (() => {
                  const status = nativeStatusOf(permission, pref)
                  const statusLabel = t(NATIVE_STATUS_KEY[status])
                  return (
                    <DropdownMenu
                      align="end"
                      contentClassName="min-w-[240px]"
                      trigger={({ toggle }) => (
                        <button
                          type="button"
                          onClick={toggle}
                          title={t('nativeTitle', { status: statusLabel })}
                          aria-label={t('nativeAria', { status: statusLabel })}
                          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          {status === 'on' ? (
                            <Bell className="size-4 text-primary" strokeWidth={1.75} />
                          ) : (
                            <BellOff
                              className={cn(
                                'size-4',
                                status === 'blocked' && 'text-destructive/70'
                              )}
                              strokeWidth={1.75}
                            />
                          )}
                        </button>
                      )}
                    >
                      <DropdownLabel>{t('nativeLabel', { status: statusLabel })}</DropdownLabel>
                      {status === 'on' && (
                        <DropdownItem icon={<BellOff />} onSelect={() => applyPref('off')}>
                          {t('turnOff')}
                        </DropdownItem>
                      )}
                      {status === 'off' && (
                        <DropdownItem icon={<Bell />} onSelect={() => applyPref('on')}>
                          {t('turnOn')}
                        </DropdownItem>
                      )}
                      {status === 'needs-permission' && (
                        <DropdownItem icon={<Bell />} onSelect={() => void enableNative()}>
                          {t('allowPermission')}
                        </DropdownItem>
                      )}
                      {status === 'blocked' && (
                        <p className="px-2 py-1.5 text-[12px] leading-relaxed text-faint">
                          {t('blockedHelp')}
                        </p>
                      )}
                      {status === 'blocked' && (
                        <DropdownItem
                          icon={<Bell />}
                          onSelect={() =>
                            setPermission(
                              typeof Notification === 'undefined'
                                ? 'unsupported'
                                : Notification.permission
                            )
                          }
                        >
                          {t('recheck')}
                        </DropdownItem>
                      )}
                    </DropdownMenu>
                  )
                })()}
            </div>
            {items.length === 0 ? (
              <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">
                {t('empty')}
              </p>
            ) : (
              <ul className="max-h-[360px] divide-y divide-border overflow-y-auto">
                {items.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button"
                      onClick={() => onItemClick(n)}
                      className="flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors hover:bg-accent"
                    >
                      <span
                        className={cn(
                          'mt-1.5 size-1.5 shrink-0 rounded-full',
                          n.readAt === undefined ? 'bg-primary' : 'bg-transparent'
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            'block truncate text-[13px]',
                            n.readAt === undefined
                              ? 'font-[560] text-foreground'
                              : 'text-muted-foreground'
                          )}
                        >
                          {n.title}
                        </span>
                        {n.body && (
                          <span className="block truncate text-[12px] text-faint">{n.body}</span>
                        )}
                        <span className="block text-[11px] text-faint">
                          {fmtTimeAgo(n.createdAt, locale)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  )
}
