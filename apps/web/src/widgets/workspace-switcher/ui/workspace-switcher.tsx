'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  Check,
  ChevronsUpDown,
  Loader2,
  LogIn,
  LogOut,
  Moon,
  Plus,
  Settings,
  Sun,
  UserCog,
} from 'lucide-react'

import { switchWorkspaceAction } from '@/features/switch-workspace'
import type { Workspace } from '@/entities/workspace'
import { can } from '@/shared/auth/can'
import { cn } from '@/shared/lib/utils'

// 이름의 첫 글자 모노그램(워크스페이스 아바타).
function monogram(name: string): string {
  const c = name.trim()[0]
  return (c ?? '?').toUpperCase()
}

function setTheme(dark: boolean) {
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  try {
    localStorage.setItem('theme', dark ? 'dark' : 'light')
  } catch {
    /* localStorage 차단 환경 */
  }
}

// 사이드바 최상단 통합 컨트롤(Linear 컨벤션): 현재 워크스페이스 + 드롭다운에서 워크스페이스 전환 +
// 새 워크스페이스 + 내 계정(계정/설정/테마/로그아웃). 별도의 하단 유저칩을 두지 않아 정보 중복을 없앤다.
export function WorkspaceSwitcher({
  current,
  workspaces,
  subject,
  roles,
  authed,
  showLogin,
}: {
  current: string // 활성 워크스페이스 id
  workspaces: Workspace[]
  subject: string
  roles: string[]
  authed: boolean
  showLogin: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const active = workspaces.find((w) => w.id === current)
  const label = active?.name ?? current
  const isDark =
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')

  function select(id: string) {
    setOpen(false)
    if (id === current) return
    startTransition(async () => {
      await switchWorkspaceAction(id)
      router.refresh()
    })
  }

  function go(href: string) {
    setOpen(false)
    router.push(href)
  }

  const itemClass =
    'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-secondary-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground'

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-md border border-border bg-card/60 px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/15 text-[13px] font-[560] text-primary ring-1 ring-inset ring-primary/25">
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : monogram(label)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-[560] tracking-tight">{label}</span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {active?.role ?? subject}
          </span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <>
          {/* 바깥 클릭 닫기 */}
          <button
            type="button"
            aria-label="닫기"
            tabIndex={-1}
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            className="absolute left-0 right-0 top-full z-40 mt-1.5 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-pop"
          >
            <p className="px-2 py-1.5 text-[11px] font-[510] uppercase tracking-wide text-faint">
              워크스페이스
            </p>
            <div className="max-h-56 overflow-auto">
              {workspaces.length === 0 ? (
                <p className="px-2 py-1.5 text-[12px] text-muted-foreground">
                  아직 워크스페이스가 없습니다.
                </p>
              ) : (
                workspaces.map((w) => {
                  const isActive = w.id === current
                  return (
                    <button
                      key={w.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={isActive}
                      onClick={() => select(w.id)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent',
                        isActive && 'bg-accent/60'
                      )}
                    >
                      <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary/15 text-[11px] font-[560] text-primary ring-1 ring-inset ring-primary/25">
                        {monogram(w.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px]">{w.name}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {w.role}
                        </span>
                      </span>
                      {isActive && <Check className="size-4 shrink-0 text-primary" />}
                    </button>
                  )
                })
              )}
            </div>
            <Link href="/dashboard/workspaces/new" onClick={() => setOpen(false)} className={itemClass}>
              <span className="grid size-6 shrink-0 place-items-center rounded-md border border-dashed border-border">
                <Plus className="size-3.5" />
              </span>
              새 워크스페이스
            </Link>

            <div className="my-1 h-px bg-border" />

            <p className="truncate px-2 py-1 text-[11px] font-[510] uppercase tracking-wide text-faint">
              {subject}
            </p>
            <button type="button" onClick={() => go('/dashboard/account')} className={itemClass}>
              <UserCog />
              계정 설정
            </button>
            {can(roles, 'settings:read') && (
              <button type="button" onClick={() => go('/dashboard/settings')} className={itemClass}>
                <Settings />
                워크스페이스 설정
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setTheme(!document.documentElement.classList.contains('dark'))
              }}
              className={itemClass}
            >
              {isDark ? <Sun /> : <Moon />}
              테마 전환
            </button>
            {showLogin && (
              <>
                <div className="my-1 h-px bg-border" />
                {authed ? (
                  <button
                    type="button"
                    onClick={() => {
                      window.location.href = '/api/auth/signout'
                    }}
                    className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-destructive transition-colors hover:bg-destructive/10 [&_svg]:size-4 [&_svg]:shrink-0"
                  >
                    <LogOut />
                    로그아웃
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      window.location.href = '/api/auth/signin'
                    }}
                    className={itemClass}
                  >
                    <LogIn />
                    로그인
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
