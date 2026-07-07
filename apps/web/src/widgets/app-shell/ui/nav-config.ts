import {
  Activity,
  BarChart3,
  Bookmark,
  Boxes,
  CalendarClock,
  Database,
  FileText,
  LayoutDashboard,
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

// First-class concepts of the SaaS surface: harness (what) · benchmark (with what) · scorecard (result) · runtime (where — execution
// infra the workspace registers itself, no default seed) + flows (views/schedules/queue) + home (overview).
// judge/metric/model/recipe/bundle are engine parts/advanced options — excluded from the nav (routes remain, reachable via URL).
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
        labelKey: 'benchmarks',
        icon: Database,
        keywords: 'benchmark dataset case pinch',
      },
      {
        href: '/scorecards',
        labelKey: 'scorecards',
        icon: BarChart3,
        keywords: 'scorecard batch evaluate compare leaderboard trend',
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
        href: '/queue',
        labelKey: 'queue',
        icon: Activity,
        keywords: 'queue job workload running waiting runtime',
      },
      {
        href: '/runtimes',
        labelKey: 'runtimes',
        icon: Server,
        keywords: 'runtime execution infra docker k8s nomad runner',
      },
      {
        href: '/report',
        labelKey: 'report',
        icon: FileText,
        keywords: 'report regression trend',
      },
    ],
  },
]

export const ALL_NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items)
