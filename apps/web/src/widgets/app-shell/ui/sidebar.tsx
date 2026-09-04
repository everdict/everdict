'use client'

import { Fragment, useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { ArrowLeft, ChevronRight, LogIn, LogOut, Menu, Search, Settings, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { WorkspaceSwitcher } from '@/widgets/workspace-switcher'
import type { Workspace } from '@/entities/workspace'
import { can } from '@/shared/auth/can'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Kbd } from '@/shared/ui/kbd'
import { Link } from '@/shared/ui/link'

import { isNavItemActive, NAV_SECTIONS, RESOURCES_SECTION } from './nav-config'
import { navGroupOpen } from './nav-group-open'
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

// The sidebar's links use `shared/ui/link` too — which means prefetch is OFF. This was where it was felt most: eighteen rows that are always
// on screen re-prefetching all at once whenever the router cache was invalidated, pushing the in-flight mutation's transition behind that
// queue. The reasons and the measurements are in the `shared/ui/link` comment.
//
// Active nav-row markup (shared by the app nav + the settings nav): indigo active bar + accent fill.
function navRowClass(active: boolean) {
  return cn(
    'group relative flex items-center gap-2.5 rounded-md px-2 py-[7px] text-[13px] font-[510] transition-colors duration-100',
    active
      ? 'bg-accent text-foreground'
      : 'text-secondary-foreground hover:bg-accent/60 hover:text-foreground'
  )
}

// The storage key for the open state of the collapsible **item** (Workspace › More). The same approach as the theme toggle, which uses
// localStorage without next-themes — with no added dependency, what a user expanded once stays expanded on the next visit.
const NAV_GROUP_STORAGE_PREFIX = 'everdict-nav-group:'

// Both the storage key and the state key — so the writing side and the restoring side build the SAME string (this used to write an `item:` key
// and read only the section key when restoring, so a group the user expanded collapsed again on every refresh).
function navItemGroupKey(labelKey: string): string {
  return `item:${labelKey}`
}

function NavLinks({ workspace, onNavigate }: { workspace: string; onNavigate?: () => void }) {
  const pathname = usePathname()
  const t = useTranslations('nav')
  // Eval nav + the pinned Resources group (guide + agent-connect entry points) render as one sectioned list.
  const sections = [...NAV_SECTIONS, RESOURCES_SECTION]
  // Only items the user toggled themselves are recorded (unrecorded = collapsed by default plus auto-expansion on the active path).
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  // Reading localStorage during render breaks hydration, so it is applied after mount. The first paint uses the default (collapsed), which is
  // the initial state we want anyway.
  useEffect(() => {
    const restored: Record<string, boolean> = {}
    for (const item of NAV_SECTIONS.flatMap((section) => section.items)) {
      if (!item.children) continue
      const key = navItemGroupKey(item.labelKey)
      const saved = window.localStorage.getItem(`${NAV_GROUP_STORAGE_PREFIX}${key}`)
      if (saved !== null) restored[key] = saved === 'open'
    }
    if (Object.keys(restored).length > 0) setOpenGroups((prev) => ({ ...restored, ...prev }))
  }, [])

  const toggleGroup = (key: string, next: boolean) => {
    setOpenGroups((prev) => ({ ...prev, [key]: next }))
    window.localStorage.setItem(`${NAV_GROUP_STORAGE_PREFIX}${key}`, next ? 'open' : 'closed')
  }

  const isActiveItem = (href: string, exact?: boolean) =>
    isNavItemActive({ href, exact }, pathname, workspace)

  return (
    <nav className="flex flex-col gap-4">
      {sections.map((section, i) => {
        const key = section.headingKey ?? section.heading ?? `s-${i}`
        return (
          <Fragment key={key}>
            <div className="flex flex-col gap-0.5">
              {/* A section heading is a label rather than a button — there is no collapse that hides a whole axis (see nav-config). */}
              {(section.headingKey || section.heading) && (
                <p className="px-2 pb-1 text-[11px] font-[510] tracking-wide text-faint">
                  {section.headingKey ? t(section.headingKey) : section.heading}
                </p>
              )}
              {section.items.map((item) => {
                const href = `/${workspace}${item.href}` // suffix → prefixed with the active workspace
                const active = isActiveItem(item.href, item.exact)
                const Icon = item.icon
                // An item with children (Workspace › More) is a button that expands IN PLACE rather than a link —
                // split out as its own section it would leave the Workspace group.
                if (item.children) {
                  const itemKey = navItemGroupKey(item.labelKey)
                  const holdsActiveChild = item.children.some((c) => isActiveItem(c.href, c.exact))
                  const childrenOpen = navGroupOpen({
                    recorded: openGroups[itemKey],
                    holdsActive: holdsActiveChild,
                  })
                  return (
                    <div key={item.href} className="flex flex-col gap-0.5">
                      <button
                        type="button"
                        onClick={() => toggleGroup(itemKey, !childrenOpen)}
                        aria-expanded={childrenOpen}
                        className={cn(rowClass, 'relative w-full text-left')}
                      >
                        <Icon className={iconClass} strokeWidth={1.75} />
                        {t(item.labelKey)}
                        <ChevronRight
                          className={cn(
                            'ml-auto size-3 shrink-0 text-faint transition-transform duration-150',
                            childrenOpen && 'rotate-90'
                          )}
                          strokeWidth={2.25}
                        />
                      </button>
                      {childrenOpen && (
                        <div className="ml-[13px] flex flex-col gap-0.5 border-l border-border/60 pl-2">
                          {item.children.map((child) => {
                            const childActive = isActiveItem(child.href, child.exact)
                            return (
                              <Link
                                key={child.href}
                                href={`/${workspace}${child.href}`}
                                onClick={onNavigate}
                                aria-current={childActive ? 'page' : undefined}
                                className={navRowClass(childActive)}
                              >
                                <span className="truncate">{t(child.labelKey)}</span>
                              </Link>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                }
                return (
                  <Link
                    key={item.href}
                    href={href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    // data-tour: the onboarding tour's spotlight anchor (nav-agents, etc.). An anchor inside a collapsible item (Workspace › More)
                    // survives because the tour navigates to that route first (step.href), which triggers the auto-expansion — and even with the
                    // anchor not found the tour continues with the card centred.
                    data-tour={`nav-${item.labelKey}`}
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
          </Fragment>
        )
      })}
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
      {/* The settings list is long enough to outgrow a short viewport — it scrolls, but paints no bar
          (`scrollbar-none`): a track appearing inside the chrome rail reads as breakage, and it also let the rows
          shift horizontally whenever it showed up. No gutter to reserve now, so the rows align with the link above. */}
      <div className="mt-1 flex-1 overflow-y-auto scrollbar-none">
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
          <button
            type="button"
            data-tour="user-menu"
            onClick={toggle}
            className={cn(rowClass, 'w-full text-left')}
          >
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
      <div data-tour="workspace-switcher">
        <WorkspaceSwitcher current={props.workspace} workspaces={props.workspaces} />
      </div>

      <button
        type="button"
        data-tour="search"
        onClick={openCommandPalette}
        className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Search className="size-4" strokeWidth={1.75} />
        <span className="flex-1 text-left">{t('searchPlaceholder')}</span>
        <Kbd>{mac ? '⌘' : 'Ctrl'} K</Kbd>
      </button>

      {/* Same chromeless rail as the settings nav — the app nav scrolls on short viewports without painting a bar. */}
      <div className="flex-1 overflow-y-auto scrollbar-none">
        <NavLinks
          workspace={props.workspace}
          onNavigate={onNavigate}
        />
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
