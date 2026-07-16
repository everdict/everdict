import {
  BarChart3,
  Bookmark,
  Boxes,
  CalendarClock,
  Database,
  Gavel,
  LayoutDashboard,
  Play,
  Server,
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
  items: NavItem[]
}

// First-class concepts of the SaaS surface: home (overview) · run (individual execution/activity) · harness (what) · benchmark
// (with what) · scorecard (result) · judge (who scores the result) · runtime (where — execution infra the workspace registers
// itself, no default seed) + flows (views/schedules).
// The work queue is no longer a nav page — it's the always-present floating work panel (widgets/work-panel) in the top-right cluster.
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
        href: '/runs',
        labelKey: 'runs',
        icon: Play,
        keywords: 'run runs activity execution history',
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
        href: '/views',
        labelKey: 'views',
        icon: Bookmark,
        keywords: 'view analysis saved dashboard leaderboard trend compare pivot',
      },
      {
        href: '/schedules',
        labelKey: 'schedules',
        icon: CalendarClock,
        keywords: 'schedule cron recurring regression',
      },
      {
        href: '/runtimes',
        labelKey: 'runtimes',
        icon: Server,
        keywords: 'runtime execution infra docker k8s nomad runner',
      },
    ],
  },
]

export const ALL_NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items)
