'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { ArrowLeft, LogIn, LogOut, Menu, Search, Settings, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { WorkspaceSwitcher } from '@/widgets/workspace-switcher'
import type { Workspace } from '@/entities/workspace'
import { can } from '@/shared/auth/can'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Kbd } from '@/shared/ui/kbd'

import { NAV_SECTIONS } from './nav-config'
import { SETTINGS_NAV_GROUPS } from './settings-nav-config'

export interface SidebarProps {
  workspace: string
  workspaces: Workspace[]
  subject: string
  roles: string[]
  authed: boolean
  showLogin: boolean
  email?: string
  profile?: { name?: string; username?: string; avatarUrl?: string }
}

// Open the Cmd+K palette — a module-level custom event (wires the search button ↔ palette without context plumbing).
function openCommandPalette() {
  window.dispatchEvent(new CustomEvent('everdict:command'))
}

function isMac() {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
}

const rowClass =
  'group flex items-center gap-2.5 rounded-md px-2 py-[7px] text-[13px] font-[510] text-secondary-foreground transition-colors duration-100 hover:bg-accent/60 hover:text-foreground'
const iconClass =
  'size-[17px] shrink-0 text-muted-foreground transition-colors group-hover:text-foreground'

// Active nav-row markup (shared by the app nav + the settings nav): indigo active bar + accent fill.
function navRowClass(active: boolean) {
  return cn(
    'group relative flex items-center gap-2.5 rounded-md px-2 py-[7px] text-[13px] font-[510] transition-colors duration-100',
    active
      ? 'bg-accent text-foreground'
      : 'text-secondary-foreground hover:bg-accent/60 hover:text-foreground'
  )
}

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
            const href = `/${workspace}${item.href}` // suffix → prefixed with the active workspace
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
                className={navRowClass(active)}
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

// Settings secondary-nav — replaces the app nav when inside /settings (Linear-style takeover). "Back to app" at the top,
// then grouped Account (always) + Workspace (role-gated: items the role can't access are hidden; an empty group is dropped).
function SettingsNav({
  workspace,
  roles,
  onNavigate,
}: {
  workspace: string
  roles: string[]
  onNavigate?: () => void
}) {
  const pathname = usePathname()
  const t = useTranslations('settingsNav')
  const base = `/${workspace}/settings`
  return (
    <>
      <Link href={`/${workspace}`} onClick={onNavigate} className={rowClass}>
        <ArrowLeft className={iconClass} strokeWidth={1.75} />
        {t('backToApp')}
      </Link>
      <div className="-mr-1 mt-1 flex-1 overflow-y-auto pr-1">
        <nav className="flex flex-col gap-4">
          {SETTINGS_NAV_GROUPS.map((group) => {
            const items = group.items.filter(
              (item) => !item.requiredAction || can(roles, item.requiredAction)
            )
            if (items.length === 0) return null
            return (
              <div key={group.headingKey} className="flex flex-col gap-0.5">
                <p className="px-2 pb-1 text-[11px] font-[510] tracking-wide text-faint">
                  {t(group.headingKey)}
                </p>
                {items.map((item) => {
                  const href = `${base}${item.href}`
                  const active = item.exact
                    ? pathname === href
                    : pathname === href || pathname.startsWith(`${href}/`)
                  const Icon = item.icon
                  return (
                    <Link
                      key={item.href || 'general'}
                      href={href}
                      onClick={onNavigate}
                      aria-current={active ? 'page' : undefined}
                      className={navRowClass(active)}
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
                          active
                            ? 'text-foreground'
                            : 'text-muted-foreground group-hover:text-foreground'
                        )}
                        strokeWidth={1.75}
                      />
                      {t(item.labelKey)}
                    </Link>
                  )
                })}
              </div>
            )
          })}
        </nav>
      </div>
    </>
  )
}

// Bottom footer — a single user entry (avatar + name) → dropdown {Settings, Log out}. Consolidates the former
// account/settings/theme/language/logout rows (theme + language now live in Settings › Preferences).
function SidebarFooter({
  workspace,
  subject,
  email,
  profile,
  authed,
  showLogin,
  onNavigate,
}: {
  workspace: string
  subject: string
  email?: string
  profile?: { name?: string; username?: string; avatarUrl?: string }
  authed: boolean
  showLogin: boolean
  onNavigate?: () => void
}) {
  const t = useTranslations('shell')
  const router = useRouter()
  const displayName = profile?.name ?? profile?.username ?? email ?? subject

  // Keycloak configured but signed out → a plain login button (no user menu to show).
  if (showLogin && !authed) {
    return (
      <div className="border-t border-border pt-2">
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
      </div>
    )
  }

  return (
    <div className="border-t border-border pt-2">
      <DropdownMenu
        side="top"
        className="w-full"
        contentClassName="w-[204px]"
        trigger={({ toggle }) => (
          <button type="button" onClick={toggle} className={cn(rowClass, 'w-full text-left')}>
            <Avatar
              name={displayName}
              {...(profile?.avatarUrl !== undefined ? { url: profile.avatarUrl } : {})}
              size="sm"
              className="rounded-full"
            />
            <span className="min-w-0 flex-1 truncate">{displayName}</span>
          </button>
        )}
      >
        <DropdownItem
          icon={<Settings />}
          onSelect={() => {
            onNavigate?.()
            router.push(`/${workspace}/settings/profile`)
          }}
        >
          {t('settings')}
        </DropdownItem>
        {authed && (
          <DropdownItem
            icon={<LogOut />}
            tone="danger"
            onSelect={() => {
              window.location.href = '/api/auth/signout'
            }}
          >
            {t('logout')}
          </DropdownItem>
        )}
      </DropdownMenu>
    </div>
  )
}

function SidebarBody({ onNavigate, ...props }: SidebarProps & { onNavigate?: () => void }) {
  const pathname = usePathname()
  const inSettings =
    pathname === `/${props.workspace}/settings` ||
    pathname.startsWith(`/${props.workspace}/settings/`)
  const mac = isMac()
  const t = useTranslations('shell')

  // Settings takeover — the whole sidebar becomes the settings nav (back-to-app + grouped sections).
  if (inSettings) {
    return (
      <div className="flex h-full flex-col gap-3 px-3 py-3.5">
        <SettingsNav workspace={props.workspace} roles={props.roles} onNavigate={onNavigate} />
      </div>
    )
  }

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

      <div className="-mr-1 flex-1 overflow-y-auto pr-1">
        <NavLinks workspace={props.workspace} onNavigate={onNavigate} />
      </div>

      <SidebarFooter
        workspace={props.workspace}
        subject={props.subject}
        {...(props.email !== undefined ? { email: props.email } : {})}
        {...(props.profile !== undefined ? { profile: props.profile } : {})}
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
      {/* Mobile top bar — pr-24 reserves the top-right corner for the floating control cluster (TopControls), so the search sits to its left. */}
      <div className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-border bg-background/80 pl-3 pr-24 backdrop-blur-xl md:hidden">
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

      {/* Desktop sidebar */}
      <aside className="sticky top-0 z-20 hidden h-screen w-[232px] shrink-0 border-r border-border bg-card/30 md:block">
        <SidebarBody {...props} />
      </aside>

      {/* Mobile drawer */}
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
