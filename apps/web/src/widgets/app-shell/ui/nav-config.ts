import {
  BarChart3,
  BookOpen,
  Bookmark,
  Boxes,
  Database,
  Gavel,
  LayoutDashboard,
  MonitorDown,
  Puzzle,
  Store,
  Terminal,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  // Workspace-relative path suffix (e.g. '' = overview, '/scorecards'). Prefixed with the active workspace at render → /{workspace}{suffix}.
  // nav-config has no request context (workspace·locale unknown at module load), so it holds only the suffix + message key.
  href: string
  labelKey: string // nav.* key in messages/*.json — resolved via useTranslations at render
  icon: LucideIcon
  exact?: boolean
  keywords?: string // command palette fuzzy-match aid words (Korean/English side by side)
}

export interface NavSection {
  heading?: string
  headingKey?: string // nav.* key — preferred over `heading` (raw) so section titles are localized
  items: NavItem[]
}

// The sidebar is the EVAL half of the split view: home (overview) · harness (what) · benchmark (with what) ·
// scorecard (result) · judge (who scores the result) + saved views.
// Infra concerns (runs · schedules · runtimes · work queue) are NOT sidebar entries — they live on the vertical
// infra rail (widgets/infra-panel) on the right; their full pages remain routable (panel "full page" links,
// command palette infra group).
// metric/model/recipe/bundle are engine parts/advanced options — excluded from the nav (routes remain, reachable via URL).
export const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      {
        href: '',
        labelKey: 'overview',
        icon: LayoutDashboard,
        exact: true,
        keywords: 'overview home',
      },
      {
        href: '/harnesses',
        labelKey: 'harnesses',
        icon: Boxes,
        keywords: 'harness agent codex claude',
      },
      {
        href: '/datasets',
        labelKey: 'datasets',
        icon: Database,
        keywords: 'benchmark dataset case pinch', // keep "benchmark" as a search alias
      },
      {
        href: '/scorecards',
        labelKey: 'scorecards',
        icon: BarChart3,
        keywords: 'scorecard batch evaluate compare leaderboard trend',
      },
      {
        href: '/judges',
        labelKey: 'judges',
        icon: Gavel,
        keywords: 'judge grader model harness rubric verdict score',
      },
      {
        href: '/store',
        labelKey: 'store',
        icon: Store,
        keywords: 'store capability tool mcp code skill adopt publish marketplace 도구 스토어',
      },
      {
        href: '/views',
        labelKey: 'views',
        icon: Bookmark,
        keywords: 'view analysis saved dashboard leaderboard trend compare pivot',
      },
    ],
  },
]

// Resources group — onboarding entry points, pinned below the eval nav. The guide walks new users through the eval
// flow; the three connect entries deep-link to the tabbed /connect hub (desktop download + Claude Code / Codex MCP
// install). Kept OUT of ALL_NAV_ITEMS so the command palette stays eval-focused.
export const RESOURCES_SECTION: NavSection = {
  headingKey: 'resources',
  items: [
    {
      href: '/guide',
      labelKey: 'guide',
      icon: BookOpen,
      keywords: 'guide getting started onboarding tour help 가이드 시작',
    },
    {
      href: '/connect/desktop',
      labelKey: 'connectDesktop',
      icon: MonitorDown,
      keywords: 'desktop app download runner 데스크탑 다운로드',
    },
    {
      href: '/connect/claude-code',
      labelKey: 'connectClaude',
      icon: Puzzle,
      keywords: 'claude code plugin mcp install 플러그인',
    },
    {
      href: '/connect/codex',
      labelKey: 'connectCodex',
      icon: Terminal,
      keywords: 'codex plugin mcp install 플러그인',
    },
  ],
}

export const ALL_NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items)
