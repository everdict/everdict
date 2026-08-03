'use client'

import { Fragment, useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { ArrowLeft, ChevronRight, LogIn, LogOut, Menu, Search, Settings, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { WorkspaceSwitcher } from '@/widgets/workspace-switcher'
import { matchTeamPath, teamHref, teamSectionHref, type TeamPathScope } from '@/entities/team'
import type { Workspace } from '@/entities/workspace'
import { can } from '@/shared/auth/can'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Kbd } from '@/shared/ui/kbd'

import { isNavItemActive, NAV_SECTIONS, RESOURCES_SECTION } from './nav-config'
import { navGroupOpen } from './nav-group-open'
import { SETTINGS_NAV_GROUPS } from './settings-nav-config'

export interface SidebarTeam {
  id: string
  key: string
  name: string
  isDefault: boolean
  // 트리아지를 켠 팀만 인박스 줄을 갖는다.
  triageEnabled: boolean
}

export interface SidebarProps {
  workspace: string
  workspaces: Workspace[]
  subject: string
  roles: string[]
  authed: boolean
  showLogin: boolean
  email?: string
  profile?: { name?: string; username?: string; avatarUrl?: string }
  teams?: SidebarTeam[]
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

// 접이식 섹션의 열림 상태 저장소 키. next-themes 없이 localStorage 를 쓰는 테마 토글과 같은 방식 — 의존성 추가 없이
// 사용자가 한 번 펼친 그룹은 다음 방문에도 펼쳐진 채로 남는다.
const NAV_GROUP_STORAGE_PREFIX = 'everdict-nav-group:'

function NavLinks({
  workspace,
  teams,
  onNavigate,
}: {
  workspace: string
  teams: SidebarTeam[]
  onNavigate?: () => void
}) {
  const pathname = usePathname()
  const t = useTranslations('nav')
  // Eval nav + the pinned Resources group (guide + agent-connect entry points) render as one sectioned list,
  // with "Your teams" spliced in AFTER the eval nav and BEFORE Resources: teams are where issues live, so they
  // belong with the tracker at the top, not below the onboarding links.
  const sections = [...NAV_SECTIONS, RESOURCES_SECTION]
  // "Your teams" 는 Workspace 그룹 바로 다음 — 이슈가 사는 곳이라 트래커 축 안에 있어야 하고, 평가 primitive
  // 들보다 앞선다. (헤딩 키로 찾는다: 섹션이 늘거나 줄어도 위치가 어긋나지 않는다.)
  const teamsAfterIndex = NAV_SECTIONS.findIndex(
    (section) => section.headingKey === 'workspaceGroup'
  )
  // 사용자가 직접 토글한 그룹만 기록한다(미기록 = 기본 접힘 + 활성 경로 자동 펼침).
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  // localStorage 는 렌더 중에 읽으면 하이드레이션이 어긋나므로 마운트 후에 반영한다. 첫 페인트는 기본값(접힘)이라
  // 어차피 우리가 원하는 초기 상태다.
  useEffect(() => {
    const restored: Record<string, boolean> = {}
    for (const section of NAV_SECTIONS) {
      if (!section.collapsible || !section.headingKey) continue
      const saved = window.localStorage.getItem(`${NAV_GROUP_STORAGE_PREFIX}${section.headingKey}`)
      if (saved !== null) restored[section.headingKey] = saved === 'open'
    }
    if (Object.keys(restored).length > 0) setOpenGroups((prev) => ({ ...restored, ...prev }))
  }, [])

  const toggleGroup = (key: string, next: boolean) => {
    setOpenGroups((prev) => ({ ...prev, [key]: next }))
    window.localStorage.setItem(`${NAV_GROUP_STORAGE_PREFIX}${key}`, next ? 'open' : 'closed')
  }

  // 지금 경로가 어느 팀의 것인가 — 한 번만 판정하고 양쪽(워크스페이스 나브 · 팀 그룹)이 같은 답을 쓴다.
  // 각자 답하던 시절에는 `/teams` 행이 팀 하위 페이지까지 자기 것이라 주장해 두 행이 동시에 켜졌다.
  const teamScope = matchTeamPath(pathname, workspace)

  const isActiveItem = (href: string, exact?: boolean) =>
    isNavItemActive({ href, exact }, pathname, workspace)

  return (
    <nav className="flex flex-col gap-4">
      {sections.map((section, i) => {
        const key = section.headingKey ?? section.heading ?? `s-${i}`
        // 활성 항목을 품은 그룹은 기본으로 펼치되, 사용자가 직접 접었으면 그 뜻이 이긴다(navGroupOpen).
        const holdsActive = section.items.some((item) => isActiveItem(item.href, item.exact))
        const open =
          !section.collapsible || navGroupOpen({ recorded: openGroups[key], holdsActive })
        return (
          <Fragment key={key}>
            <div className="flex flex-col gap-0.5">
              {section.collapsible && section.headingKey ? (
                <button
                  type="button"
                  onClick={() => toggleGroup(section.headingKey ?? key, !open)}
                  aria-expanded={open}
                  className="group flex items-center gap-1 rounded-md px-2 pb-1 pt-0.5 text-[11px] font-[510] tracking-wide text-faint transition-colors hover:text-secondary-foreground"
                >
                  <ChevronRight
                    className={cn('size-3 transition-transform duration-150', open && 'rotate-90')}
                    strokeWidth={2.25}
                  />
                  {t(section.headingKey)}
                </button>
              ) : (
                (section.headingKey || section.heading) && (
                  <p className="px-2 pb-1 text-[11px] font-[510] tracking-wide text-faint">
                    {section.headingKey ? t(section.headingKey) : section.heading}
                  </p>
                )
              )}
              {open &&
                section.items.map((item) => {
                  const href = `/${workspace}${item.href}` // suffix → prefixed with the active workspace
                  const active = isActiveItem(item.href, item.exact)
                  const Icon = item.icon
                  // children 을 가진 항목(Workspace › More)은 링크가 아니라 그 자리에서 펼쳐지는 버튼이다 —
                  // 별도 섹션으로 빼면 Workspace 그룹 밖으로 나가버린다.
                  if (item.children) {
                    const itemKey = `item:${item.labelKey}`
                    const holdsActiveChild = item.children.some((c) =>
                      isActiveItem(c.href, c.exact)
                    )
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
                      // data-tour: 온보딩 투어의 스포트라이트 앵커(nav-harnesses 등). 접이식 그룹 안의 앵커는 투어가 해당
                      // 라우트로 먼저 이동하면서(step.href) 자동 펼침이 걸려 살아난다 — 앵커를 못 찾아도 투어는 카드만
                      // 중앙에 띄우고 계속된다.
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
            {i === teamsAfterIndex && (
              <TeamsNav
                workspace={workspace}
                teams={teams}
                scope={teamScope}
                onNavigate={onNavigate}
              />
            )}
          </Fragment>
        )
      })}
    </nav>
  )
}

// 사이드바의 팀 섹션 — Linear 의 "Your teams", 그리고 이 제품에서 이슈의 유일한 집. 내가 속한 팀만 보여준다
// (팀 멤버십이 워크스페이스 멤버십과 별도 로스터인 이유가 이것이다).
//
// 팀은 링크가 아니라 펼쳐지는 그룹이다: 이슈는 `teamId` 가 필수이고 식별자도 `<KEY>-123` 으로 팀이 발번하므로,
// 팀은 이슈를 거르는 필터가 아니라 이슈가 사는 곳이다. 그래서 최상단의 평평한 "Issues" 항목을 없애고 각 팀이
// 자기 이슈 목록을 소유하게 했다. 프로젝트는 종류가 하나뿐이다 — 워크스페이스의 것이면서 자기 팀들을 이름으로
// 들고 있고(`teamIds`, 최소 하나), 그래서 워크스페이스 목록과 팀 아래 목록은 같은 한 컬렉션의 두 주소다.
//
// 팀이 하나뿐이어도 감추지 않는다. 예전에는 감췄지만, 그러면 이슈가 팀에 속한다는 사실 자체가 화면에서 사라져
// 워크스페이스 전역 목록처럼 보인다 — 팀 키(`ENG`)는 이슈 번호에 이미 박혀 있으니 하나뿐인 팀도 보여줄 값이 있다.
function TeamsNav({
  workspace,
  teams,
  scope,
  onNavigate,
}: {
  workspace: string
  teams: SidebarTeam[]
  // 어느 팀의 화면을 보고 있나 — 전부 경로가 말한다(`/{workspace}/teams/ENG/…`). 판정은 위에서 한 번만 하고
  // 내려받는다: 이 그룹과 워크스페이스 나브가 각자 경로를 읽으면 둘 다 자기 것이라 주장할 수 있다.
  scope: TeamPathScope | null
  onNavigate?: () => void
}) {
  const t = useTranslations('nav')
  const [openTeams, setOpenTeams] = useState<Record<string, boolean>>({})
  if (teams.length === 0) return null
  return (
    <div className="flex flex-col gap-0.5">
      <p className="px-2 pb-1 text-[11px] font-[510] tracking-wide text-faint">{t('yourTeams')}</p>
      {teams.map((team) => {
        // 활성 스코프인 팀은 기본으로 펼치되, 사용자가 접었으면 접힌 채로 둔다. 팀이 하나뿐이면 접을 이유도
        // 없으니 그때의 기본은 펼침이다.
        const holdsActive = scope?.key === team.key
        const open = navGroupOpen({
          recorded: openTeams[team.id],
          holdsActive,
          whenUnrecorded: teams.length === 1,
        })
        // 팀이 소유하는 것은 전부 팀 아래의 경로 자원이다 — `/{workspace}/teams/ENG/issues`. 목록은 여전히
        // 한 벌이지만(같은 컴포넌트, 다른 주소), 팀마다 가진 것이 다르다는 사실은 URL 이 말한다.
        // 하네스·데이터셋·저지도 팀 소유지만 사이드바 행은 주지 않는다: 이름을 대고 찾아가는 것은
        // 스코어카드이고, 나머지는 그 스코어카드나 팀에서 도달한다. 행이 늘어날수록 팀 그룹이 벽이 된다.
        const children = [
          { href: teamHref(workspace, team.key), labelKey: 'teamHome', page: 'home' },
          {
            href: teamSectionHref(workspace, team.key, 'issues'),
            labelKey: 'issues',
            page: 'issues',
          },
          // 사이클은 팀의 것이다 — 팀 밖에 두면 "Cycle 3"이 누구의 세 번째인지 알 수 없다.
          {
            href: teamSectionHref(workspace, team.key, 'cycles'),
            labelKey: 'cycles',
            page: 'cycles',
          },
          // 트리아지는 그 팀이 켰을 때만 — 큐를 요청하지 않은 팀에게 빈 인박스를 보여줄 이유가 없다.
          ...(team.triageEnabled
            ? [
                {
                  href: teamSectionHref(workspace, team.key, 'triage'),
                  labelKey: 'triage',
                  page: 'triage',
                },
              ]
            : []),
          {
            href: teamSectionHref(workspace, team.key, 'projects'),
            labelKey: 'projects',
            page: 'projects',
          },
          {
            href: teamSectionHref(workspace, team.key, 'scorecards'),
            labelKey: 'scorecards',
            page: 'scorecards',
          },
        ]
        return (
          <div key={team.id} className="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => setOpenTeams((prev) => ({ ...prev, [team.id]: !open }))}
              aria-expanded={open}
              className={cn(rowClass, 'relative w-full text-left')}
            >
              <ChevronRight
                className={cn(
                  'size-3 shrink-0 text-faint transition-transform duration-150',
                  open && 'rotate-90'
                )}
                strokeWidth={2.25}
              />
              <span className="inline-flex size-[17px] shrink-0 items-center justify-center rounded-sm bg-muted font-mono text-[9px] font-semibold uppercase text-muted-foreground">
                {team.key.slice(0, 2)}
              </span>
              <span className="truncate">{team.name}</span>
            </button>
            {open && (
              <div className="ml-[13px] flex flex-col gap-0.5 border-l border-border/60 pl-2">
                {children.map((child) => {
                  // 경로 하나로 판정된다 — 어느 팀인지도, 그 팀의 어느 자원인지도 URL 이 들고 있다.
                  const active = holdsActive && scope?.section === child.page
                  return (
                    <Link
                      key={child.page}
                      href={child.href}
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
                      <span className="truncate">{t(child.labelKey)}</span>
                    </Link>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
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
        <NavLinks workspace={props.workspace} teams={props.teams ?? []} onNavigate={onNavigate} />
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
