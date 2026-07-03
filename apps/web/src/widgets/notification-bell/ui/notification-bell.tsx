'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, BellRing, Check } from 'lucide-react'

import { notificationsResponseSchema, type NotificationItem } from '@/entities/notification'
import { fmtTimeAgo } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'

// 알림 벨(사이드바) — 개인 피드 인박스. docs/architecture/notifications.md:
// 폴링(25s + 창 포커스)으로 /api/notifications(BFF 프록시)를 읽고, 새 미읽음은 표준 Web Notification 으로
// 발화한다(N1 — 데스크톱 셸에서는 Electron 이 이를 OS 알림으로 라우팅; 창이 숨겨져 있을 때만 발화해 소음 방지).
const POLL_MS = 25_000
const NATIVE_FIRE_CAP = 3 // 한 폴링에서 네이티브 알림 최대 발화 수(폭주 방지)

function hrefOf(workspace: string, n: NotificationItem): string {
  if (n.link?.runId) return `/${workspace}/runs/${n.link.runId}`
  if (n.link?.scorecardId) return `/${workspace}/scorecards/${n.link.scorecardId}`
  return `/${workspace}`
}

type Permission = NotificationPermission | 'unsupported'

export function NotificationBell({ workspace }: { workspace: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationItem[]>([])
  const [permission, setPermission] = useState<Permission>('unsupported')
  const seeded = useRef(false) // 첫 로드 배치는 네이티브 발화 대상이 아니다(앱 켜자마자 과거 알림 폭주 방지)
  const seen = useRef<Set<string>>(new Set())

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
      // 네이티브 발화 — 창이 안 보일 때만(보이는 탭은 배지로 충분). 데스크톱(트레이 상주)의 핵심 경로.
      if (
        seeded.current &&
        document.hidden &&
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
      // 폴링 실패는 조용히 — 다음 주기에 재시도.
    }
  }, [router, workspace])

  useEffect(() => {
    setPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    const onFocus = () => void poll()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
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
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`알림${unread > 0 ? ` (미읽음 ${unread})` : ''}`}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors',
          open
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        )}
      >
        {unread > 0 ? (
          <BellRing className="size-4 text-primary" strokeWidth={1.75} />
        ) : (
          <Bell className="size-4" strokeWidth={1.75} />
        )}
        <span className="flex-1 text-left">알림</span>
        {unread > 0 && (
          <span className="grid min-w-5 place-items-center rounded-full bg-primary px-1 text-[11px] font-[560] leading-4 text-primary-foreground">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* 바깥 클릭 닫기 */}
          <button
            type="button"
            aria-label="알림 닫기"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 top-full z-50 mt-1 w-[320px] rounded-lg border border-border bg-card shadow-pop">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-[13px] font-[560] text-foreground">알림</span>
              <span className="flex items-center gap-2">
                {permission === 'default' && (
                  <button
                    type="button"
                    onClick={() => void enableNative()}
                    className="text-[12px] text-primary hover:underline"
                  >
                    브라우저 알림 켜기
                  </button>
                )}
                {permission === 'denied' && (
                  <span className="text-[11px] text-faint">브라우저 알림 차단됨</span>
                )}
                {unread > 0 && (
                  <button
                    type="button"
                    onClick={() => void markRead({ all: true })}
                    className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
                  >
                    <Check className="size-3.5" />
                    모두 읽음
                  </button>
                )}
              </span>
            </div>
            {items.length === 0 ? (
              <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">
                아직 알림이 없습니다 — 작업이 끝나면 여기로 옵니다.
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
                          {fmtTimeAgo(n.createdAt)}
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
