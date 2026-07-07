'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LogIn, LogOut, Menu, Moon, Search, Settings, Sun, UserCog, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { NotificationBell } from '@/widgets/notification-bell'
import { WorkspaceSwitcher } from '@/widgets/workspace-switcher'
import { LocaleSwitcher } from '@/features/switch-locale'
import type { Workspace } from '@/entities/workspace'
import { can } from '@/shared/auth/can'
import { cn } from '@/shared/lib/utils'
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

const rowClass =
  'group flex items-center gap-2.5 rounded-md px-2 py-[7px] text-[13px] font-[510] text-secondary-foreground transition-colors duration-100 hover:bg-accent/60 hover:text-foreground'
const iconClass =
  'size-[17px] shrink-0 text-muted-foreground transition-colors group-hover:text-foreground'

function NavLinks({ workspace, onNavigate }: { workspace: string; onNavigate?: () => void }) {
  const pathname = usePathname()
  const t = useTranslations('nav')
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
            const href = `/${workspace}${item.href}` // suffix → 활성 워크스페이스로 prefix
            const active = item.exact
              ? pathname === href
              : pathname === href || pathname.startsWith(`${href}/`)
            const Icon = item.icon
            return (
              <Link
                key={item.href}
                href={href}
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
                {t(item.labelKey)}
              </Link>
            )
          })}
        </div>
      ))}
    </nav>
  )
}

// 하단 푸터 — 계정/설정/테마/로그아웃 직접 링크. 워크스페이스 칩과 생김새를 분리(중복 제거),
// 드롭다운에 의존하지 않아 항상 보이고 항상 눌린다.
function SidebarFooter({
  workspace,
  roles,
  authed,
  showLogin,
  onNavigate,
}: {
  workspace: string
  roles: string[]
  authed: boolean
  showLogin: boolean
  onNavigate?: () => void
}) {
  const pathname = usePathname()
  const t = useTranslations('shell')
  const accountActive = pathname === `/${workspace}/account`
  const settingsActive = pathname.startsWith(`/${workspace}/settings`)
  return (
    <div className="flex flex-col gap-0.5 border-t border-border pt-2">
      <Link
        href={`/${workspace}/account`}
        onClick={onNavigate}
        aria-current={accountActive ? 'page' : undefined}
        className={cn(rowClass, accountActive && 'bg-accent text-foreground')}
      >
        <UserCog className={cn(iconClass, accountActive && 'text-foreground')} strokeWidth={1.75} />
        {t('account')}
      </Link>
      {can(roles, 'settings:read') && (
        <Link
          href={`/${workspace}/settings`}
          onClick={onNavigate}
          aria-current={settingsActive ? 'page' : undefined}
          className={cn(rowClass, settingsActive && 'bg-accent text-foreground')}
        >
          <Settings
            className={cn(iconClass, settingsActive && 'text-foreground')}
            strokeWidth={1.75}
          />
          {t('workspaceSettings')}
        </Link>
      )}
      <button
        type="button"
        onClick={() => setTheme(!document.documentElement.classList.contains('dark'))}
        className={cn(rowClass, 'w-full text-left')}
      >
        <Sun className={cn(iconClass, 'hidden dark:block')} strokeWidth={1.75} />
        <Moon className={cn(iconClass, 'block dark:hidden')} strokeWidth={1.75} />
        {t('toggleTheme')}
      </button>
      <LocaleSwitcher rowClassName={rowClass} />
      {showLogin &&
        (authed ? (
          <button
            type="button"
            onClick={() => {
              window.location.href = '/api/auth/signout'
            }}
            className="group flex w-full items-center gap-2.5 rounded-md px-2 py-[7px] text-left text-[13px] font-[510] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          >
            <LogOut className="size-[17px] shrink-0" strokeWidth={1.75} />
            {t('logout')}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              window.location.href = '/api/auth/signin'
            }}
            className={cn(rowClass, 'w-full text-left')}
          >
            <LogIn className={iconClass} strokeWidth={1.75} />
            {t('login')}
          </button>
        ))}
    </div>
  )
}

function SidebarBody({ onNavigate, ...props }: SidebarProps & { onNavigate?: () => void }) {
  const mac = isMac()
  const t = useTranslations('shell')
  return (
    <div className="flex h-full flex-col gap-3 px-3 py-3.5">
      <WorkspaceSwitcher current={props.workspace} workspaces={props.workspaces} />

      <button
        type="button"
        onClick={openCommandPalette}
        className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Search className="size-4" strokeWidth={1.75} />
        <span className="flex-1 text-left">{t('searchPlaceholder')}</span>
        <Kbd>{mac ? '⌘' : 'Ctrl'} K</Kbd>
      </button>

      {/* 알림 인박스(개인 피드) — Linear 의 Inbox 위치. [workspace] 레이아웃이 principal 을 이미 검증했으므로
          별도 게이트 없음(dev 폴백 포함 — authed 는 실 OIDC 전용 플래그라 부적합). */}
      <NotificationBell workspace={props.workspace} />

      <div className="-mr-1 flex-1 overflow-y-auto pr-1">
        <NavLinks workspace={props.workspace} onNavigate={onNavigate} />
      </div>

      <SidebarFooter
        workspace={props.workspace}
        roles={props.roles}
        authed={props.authed}
        showLogin={props.showLogin}
        onNavigate={onNavigate}
      />
    </div>
  )
}

export function Sidebar(props: SidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const t = useTranslations('shell')
  const activeWorkspace = props.workspaces.find((w) => w.id === props.workspace)
  const workspaceLabel = activeWorkspace?.name ?? props.workspace
  return (
    <>
      {/* 모바일 상단 바 */}
      <div className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-border bg-background/80 px-3 backdrop-blur-xl md:hidden">
        <button
          type="button"
          aria-label={t('openMenu')}
          onClick={() => setMobileOpen(true)}
          className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Menu className="size-[18px]" />
        </button>
        <Link
          href={`/${props.workspace}`}
          className="flex min-w-0 items-center gap-2 text-[14px] font-[600] tracking-tight"
        >
          <span className="grid size-6 shrink-0 place-items-center rounded-md bg-primary/15 text-[12px] font-[560] text-primary ring-1 ring-inset ring-primary/25">
            {(workspaceLabel.trim()[0] ?? '?').toUpperCase()}
          </span>
          <span className="truncate">{workspaceLabel}</span>
        </Link>
        <button
          type="button"
          aria-label={t('search')}
          onClick={openCommandPalette}
          className="ml-auto grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Search className="size-[18px]" />
        </button>
      </div>

      {/* 데스크톱 사이드바 */}
      <aside className="sticky top-0 z-20 hidden h-screen w-[232px] shrink-0 border-r border-border bg-card/30 md:block">
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
              aria-label={t('close')}
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
