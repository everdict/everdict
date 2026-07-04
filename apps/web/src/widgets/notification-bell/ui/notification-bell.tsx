'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, BellOff, BellRing, Check } from 'lucide-react'

import { notificationsResponseSchema, type NotificationItem } from '@/entities/notification'
import { getAssayDesktop } from '@/shared/lib/desktop-bridge'
import { fmtTimeAgo } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { DropdownItem, DropdownLabel, DropdownMenu } from '@/shared/ui/dropdown-menu'

// 알림 벨(사이드바) — 개인 피드 인박스. docs/architecture/notifications.md:
// 폴링(25s + 창 포커스)으로 /api/notifications(BFF 프록시)를 읽고, 새 미읽음은 표준 Web Notification 으로
// 발화한다(N1 — 데스크톱 셸에서는 Electron 이 이를 OS 알림으로 라우팅; 창이 숨겨져 있을 때만 발화해 소음 방지).
const POLL_MS = 25_000
const NATIVE_FIRE_CAP = 3 // 한 폴링에서 네이티브 알림 최대 발화 수(폭주 방지)

// 리소스 타입 → 상세 경로 세그먼트(예약은 상세가 없어 edit 로). 댓글 멘션 링크가 이 매핑으로 상세로 이동.
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
  // 리소스 댓글 멘션 — resourceType→경로 매핑, commentId 앵커로 해당 댓글까지 스크롤.
  if (n.link?.resourceType && n.link?.resourceId) {
    const seg = RESOURCE_PATH[n.link.resourceType]?.(encodeURIComponent(n.link.resourceId))
    if (seg)
      return `/${workspace}/${seg}${n.link.commentId ? `#comment-${n.link.commentId}` : ''}`
  }
  return `/${workspace}`
}

type Permission = NotificationPermission | 'unsupported'

// 유저의 네이티브 알림 선호(끄기/켜기) — 브라우저 권한과 별개의 로컬 스위치. 기본 켜짐.
const NATIVE_PREF_KEY = 'assay:native-notifications'
type NativePref = 'on' | 'off'

// 권한 × 선호 → 상태 아이콘/드롭다운이 쓰는 파생 상태.
type NativeStatus = 'on' | 'off' | 'needs-permission' | 'blocked'
function nativeStatusOf(permission: Permission, pref: NativePref): NativeStatus {
  if (permission === 'denied') return 'blocked'
  if (permission === 'default') return 'needs-permission'
  return pref === 'on' ? 'on' : 'off'
}
const NATIVE_STATUS_LABEL: Record<NativeStatus, string> = {
  on: '켜짐',
  off: '꺼짐',
  'needs-permission': '권한 필요',
  blocked: '브라우저에서 차단됨',
}

export function NotificationBell({ workspace }: { workspace: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationItem[]>([])
  const [permission, setPermission] = useState<Permission>('unsupported')
  const [pref, setPref] = useState<NativePref>('on')
  const prefRef = useRef<NativePref>('on') // 폴링 클로저에서 최신 선호를 읽기 위한 ref
  const seeded = useRef(false) // 첫 로드 배치는 네이티브 발화 대상이 아니다(앱 켜자마자 과거 알림 폭주 방지)
  const seen = useRef<Set<string>>(new Set())
  // 데스크톱 셸 + 러너 페어링이면 네이티브 발화를 메인 프로세스 워처(N6, 웹 세션 무관)에 양보 — 중복 방지.
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
      // 네이티브 발화 — 창이 안 보일 때만(보이는 탭은 배지로 충분). 데스크톱(트레이 상주)의 핵심 경로.
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
      // 폴링 실패는 조용히 — 다음 주기에 재시도.
    }
  }, [router, workspace])

  useEffect(() => {
    const bridge = getAssayDesktop()
    if (bridge) {
      void bridge
        .runnerStatus()
        .then((s) => {
          desktopHandlesNative.current = s.paired
        })
        .catch(() => {})
      // 구독 해지는 아래 cleanup 에서 폴링 타이머와 함께.
      const off = bridge.onRunnerStatus((s) => {
        desktopHandlesNative.current = s.paired
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
            {/* 헤더 — 타이틀 없이 컨트롤만: 네이티브 알림 상태 아이콘(클릭→상태 변경 드롭다운) + 모두 읽음. */}
            <div className="flex items-center justify-end gap-1 border-b border-border px-2 py-1.5">
              {unread > 0 && (
                <button
                  type="button"
                  onClick={() => void markRead({ all: true })}
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  <Check className="size-3.5" />
                  모두 읽음
                </button>
              )}
              {permission !== 'unsupported' &&
                (() => {
                  const status = nativeStatusOf(permission, pref)
                  return (
                    <DropdownMenu
                      align="end"
                      contentClassName="min-w-[240px]"
                      trigger={({ toggle }) => (
                        <button
                          type="button"
                          onClick={toggle}
                          title={`네이티브 알림: ${NATIVE_STATUS_LABEL[status]}`}
                          aria-label={`네이티브 알림 설정 (${NATIVE_STATUS_LABEL[status]})`}
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
                      <DropdownLabel>네이티브 알림 — {NATIVE_STATUS_LABEL[status]}</DropdownLabel>
                      {status === 'on' && (
                        <DropdownItem icon={<BellOff />} onSelect={() => applyPref('off')}>
                          알림 끄기
                        </DropdownItem>
                      )}
                      {status === 'off' && (
                        <DropdownItem icon={<Bell />} onSelect={() => applyPref('on')}>
                          알림 켜기
                        </DropdownItem>
                      )}
                      {status === 'needs-permission' && (
                        <DropdownItem icon={<Bell />} onSelect={() => void enableNative()}>
                          권한 허용하기
                        </DropdownItem>
                      )}
                      {status === 'blocked' && (
                        <p className="px-2 py-1.5 text-[12px] leading-relaxed text-faint">
                          브라우저가 이 사이트의 알림을 차단했습니다. 주소창의 사이트 설정에서
                          허용한 뒤 아래로 다시 확인하세요.
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
                          다시 확인
                        </DropdownItem>
                      )}
                    </DropdownMenu>
                  )
                })()}
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
