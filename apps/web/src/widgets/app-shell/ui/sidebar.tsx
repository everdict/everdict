'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  ChevronsUpDown,
  FlaskConical,
  LogIn,
  LogOut,
  Menu,
  Moon,
  Search,
  Settings,
  Sun,
  UserCog,
  X,
} from 'lucide-react'

import { WorkspaceSwitcher } from '@/widgets/workspace-switcher'
import type { Workspace } from '@/entities/workspace'
import { can } from '@/shared/auth/can'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import {
  DropdownItem,
  DropdownLabel,
  DropdownMenu,
  DropdownSeparator,
} from '@/shared/ui/dropdown-menu'
import { Kbd } from '@/shared/ui/kbd'

import { NAV_SECTIONS } from './nav-config'

export interface SidebarProps {
  workspace: string
  workspaces: Workspace[]
  subject: string
  roles: string[]
  authed: boolean
  showLogin: boolean
}

// Cmd+K 팔레트 열기 — 모듈 레벨 커스텀 이벤트(컨텍스트 배선 없이 검색 버튼 ↔ 팔레트 연결).
function openCommandPalette() {
  window.dispatchEvent(new CustomEvent('assay:command'))
}

function isMac() {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
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

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname()
  return (
    <nav className="flex flex-col gap-4">
      {NAV_SECTIONS.map((section, i) => (
        <div key={section.heading ?? `s-${i}`} className="flex flex-col gap-0.5">
          {section.heading && (
            <p className="px-2 pb-1 text-[11px] font-[510] tracking-wide text-faint">
              {section.heading}
            </p>
          )}
          {section.items.map((item) => {
            const active = item.exact
              ? pathname === item.href
              : pathname === item.href || pathname.startsWith(`${item.href}/`)
            const Icon = item.icon
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'group relative flex items-center gap-2.5 rounded-md px-2 py-[7px] text-[13px] font-[510] transition-colors duration-100',
                  active
                    ? 'bg-accent text-foreground'
                    : 'text-secondary-foreground hover:bg-accent/60 hover:text-foreground'
                )}
              >
                <span
                  className={cn(
                    'absolute left-0 top-1/2 h-3.5 w-0.5 -translate-y-1/2 rounded-full bg-primary transition-opacity',
                    active ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <Icon
                  className={cn(
                    'size-[17px] shrink-0 transition-colors',
                    active ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground'
                  )}
                  strokeWidth={1.75}
                />
                {item.label}
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

function UserMenu({
  subject,
  roles,
  authed,
  showLogin,
}: {
  subject: string
  roles: string[]
  authed: boolean
  showLogin: boolean
}) {
  const router = useRouter()
  const isDark =
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  return (
    <DropdownMenu
      align="start"
      side="top"
      contentClassName="left-0 right-0"
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Avatar name={subject} size="lg" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-[510] text-foreground">{subject}</span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {roles.length > 0 ? roles.join(' · ') : authed ? '인증됨' : 'dev'}
            </span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      )}
    >
      <DropdownLabel>내 계정</DropdownLabel>
      <DropdownItem icon={<UserCog />} onSelect={() => router.push('/dashboard/account')}>
        계정 설정
      </DropdownItem>
      {can(roles, 'settings:read') && (
        <DropdownItem icon={<Settings />} onSelect={() => router.push('/dashboard/settings')}>
          워크스페이스 설정
        </DropdownItem>
      )}
      <DropdownItem
        icon={isDark ? <Sun /> : <Moon />}
        onSelect={() => setTheme(!document.documentElement.classList.contains('dark'))}
      >
        테마 전환
      </DropdownItem>
      {showLogin && (
        <>
          <DropdownSeparator />
          {authed ? (
            <DropdownItem
              tone="danger"
              icon={<LogOut />}
              onSelect={() => {
                window.location.href = '/api/auth/signout'
              }}
            >
              로그아웃
            </DropdownItem>
          ) : (
            <DropdownItem
              icon={<LogIn />}
              onSelect={() => {
                window.location.href = '/api/auth/signin'
              }}
            >
              로그인
            </DropdownItem>
          )}
        </>
      )}
    </DropdownMenu>
  )
}

function SidebarBody({ onNavigate, ...props }: SidebarProps & { onNavigate?: () => void }) {
  const mac = isMac()
  return (
    <div className="flex h-full flex-col gap-3 px-3 py-3.5">
      <div className="flex items-center gap-2 px-1">
        <span className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground shadow-[0_0_0_1px_rgba(255,255,255,0.12)_inset,0_4px_12px_-4px_var(--primary)]">
          <FlaskConical className="size-[16px]" />
        </span>
        <span className="text-[15px] font-[600] tracking-[-0.01em]">Assay</span>
      </div>

      <WorkspaceSwitcher current={props.workspace} workspaces={props.workspaces} />

      <button
        type="button"
        onClick={openCommandPalette}
        className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Search className="size-4" strokeWidth={1.75} />
        <span className="flex-1 text-left">검색·이동</span>
        <Kbd>{mac ? '⌘' : 'Ctrl'} K</Kbd>
      </button>

      <div className="-mr-1 flex-1 overflow-y-auto pr-1">
        <NavLinks onNavigate={onNavigate} />
      </div>

      <div className="border-t border-border pt-2">
        <UserMenu
          subject={props.subject}
          roles={props.roles}
          authed={props.authed}
          showLogin={props.showLogin}
        />
      </div>
    </div>
  )
}

export function Sidebar(props: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false)
  return (
    <>
      {/* 모바일 상단 바 */}
      <div className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur-xl md:hidden">
        <button
          type="button"
          aria-label="메뉴 열기"
          onClick={() => setMobileOpen(true)}
          className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Menu className="size-[18px]" />
        </button>
        <span className="flex items-center gap-1.5 text-[14px] font-[600] tracking-tight">
          <FlaskConical className="size-4 text-primary" /> Assay
        </span>
        <button
          type="button"
          aria-label="검색"
          onClick={openCommandPalette}
          className="ml-auto grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Search className="size-[18px]" />
        </button>
      </div>

      {/* 데스크톱 사이드바 */}
      <aside className="sticky top-0 hidden h-screen w-[232px] shrink-0 border-r border-border bg-card/30 md:block">
        <SidebarBody {...props} />
      </aside>

      {/* 모바일 드로어 */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-[1px] animate-in fade-in-0"
            onClick={() => setMobileOpen(false)}
          />
          <div className="absolute left-0 top-0 h-full w-[264px] border-r border-border bg-background shadow-pop animate-in slide-in-from-left-2 duration-150">
            <button
              type="button"
              aria-label="닫기"
              onClick={() => setMobileOpen(false)}
              className="absolute right-2 top-2.5 z-10 grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-[18px]" />
            </button>
            <SidebarBody {...props} onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      )}
    </>
  )
}
