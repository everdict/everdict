import {
  BarChart3,
  Bookmark,
  BookOpen,
  Bot,
  Boxes,
  CircleDot,
  Database,
  Ellipsis,
  FolderKanban,
  Gavel,
  LayoutDashboard,
  MonitorDown,
  Puzzle,
  Rocket,
  Store,
  Terminal,
  Users,
  UsersRound,
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
  // 항목 자체가 펼쳐지는 경우(리니어의 Workspace › More). 섹션이 아니라 항목이 여는 이유는 이것이 워크스페이스
  // 그룹의 일부이기 때문이다 — 별도 섹션으로 빼면 Workspace 밖으로 나가버린다.
  children?: NavItem[]
}

export interface NavSection {
  heading?: string
  headingKey?: string // nav.* key — preferred over `heading` (raw) so section titles are localized
  items: NavItem[]
  // 접이식 섹션(기본 접힘). 사이드바의 1차 관심사는 트래커이고, 평가 primitive 들은 그 아래로 물러난다.
  // 접혀 있어도 ① 현재 경로가 이 섹션 안이면 자동으로 펼쳐지고 ② 명령 팔레트에는 그대로 남아, 도달성은 유지된다.
  collapsible?: boolean
}

// Issues are NOT a top-level entry: every issue carries a required `teamId` and its identifier is minted by the
// team (`ENG-123`), so the team is where issues live, not a filter over a global list. Each team in the sidebar's
// "Your teams" group owns its Issues (and a team-scoped Projects view) — see TeamsNav in sidebar.tsx. The
// `/issues` route still exists (workspace-wide, reachable by URL and from the command palette); it just is not
// the way you navigate to work, which is what made the team axis invisible before.
// The sidebar leads with the TRACKER (docs/tracker.md) — Initiative ⊃ Project ⊃ Issue. That is the deliberate
// order of the product's questions: "why are we evaluating this, and can we ship" comes first, and the eval
// primitives that answer "what ran" (harness · dataset · scorecard · judge · store · view · agent) sit under a
// collapsed "Evaluation" group. Nothing is removed — the group expands on click, auto-expands whenever the
// active route is inside it, and every entry stays in the command palette (ALL_NAV_ITEMS).
// Infra concerns (runs · schedules · runtimes · work queue) are NOT sidebar entries — they live on the vertical
// infra rail (widgets/infra-panel) on the right; their full pages remain routable (panel "full page" links,
// command palette infra group).
// metric/model/recipe/bundle are engine parts/advanced options — excluded from the nav (routes remain, reachable via URL).
// files/knowledge are workspace *configuration* surfaces, not eval objects: their single home is Settings
// (Settings › Files, Settings › Agent › Knowledge — see settings-nav-config). The legacy top-level routes stay
// reachable via URL but are deliberately absent from the sidebar and the command palette.
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
    ],
  },
  // Workspace — what spans every team. Initiatives group projects; projects span teams (a project record carries
  // an initiative, never a team); Views are the saved analysis lenses. `More` holds the workspace rosters, which
  // are configuration screens you visit rarely — they live under /settings and are LINKED here rather than moved,
  // so there is exactly one Members page in the product.
  {
    headingKey: 'workspaceGroup',
    items: [
      {
        href: '/initiatives',
        labelKey: 'initiatives',
        icon: Rocket,
        keywords: 'initiative release readiness ship 이니셔티브 릴리스 준비',
      },
      {
        href: '/projects',
        labelKey: 'projects',
        icon: FolderKanban,
        keywords: 'project milestone target date rollup 프로젝트 마일스톤 목표일',
      },
      {
        href: '/views',
        labelKey: 'views',
        icon: Bookmark,
        keywords: 'view analysis saved dashboard leaderboard trend compare pivot',
      },
      // ⚠ The two rosters are /settings routes on purpose — the sidebar surfaces them, Settings owns them,
      // so the product has exactly one Members page. Clicking one hands the sidebar over to Settings.
      {
        href: '/settings/members',
        labelKey: 'more',
        icon: Ellipsis,
        keywords: 'more member team roster 더보기 멤버 팀',
        children: [
          {
            href: '/settings/members',
            labelKey: 'members',
            icon: Users,
            keywords: 'member people invite role 멤버 초대 역할',
          },
          {
            href: '/settings/teams',
            labelKey: 'teams',
            icon: UsersRound,
            keywords: 'team roster key 팀 로스터',
          },
        ],
      },
    ],
  },
  {
    headingKey: 'evaluation',
    collapsible: true,
    items: [
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
        href: '/agents',
        labelKey: 'agents',
        icon: Bot,
        keywords: 'agent fleet run trigger automation 에이전트 자동화 플릿',
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

// The workspace-wide issue list has no sidebar row (issues belong to a team — see the note above), but it stays
// in the palette: cross-team triage is a real question, and Cmd+K is where you ask one without leaving a team.
const WORKSPACE_ISSUES_ITEM: NavItem = {
  href: '/issues',
  labelKey: 'allIssues',
  icon: CircleDot,
  keywords: 'issue bug regression triage tracker all teams 이슈 회귀 트래커 전체',
}

export const ALL_NAV_ITEMS: NavItem[] = [
  // children 까지 평탄화 — 펼치지 않아도 Cmd+K 로는 닿아야 한다.
  ...NAV_SECTIONS.flatMap((s) => s.items.flatMap((item) => item.children ?? [item])),
  WORKSPACE_ISSUES_ITEM,
]
