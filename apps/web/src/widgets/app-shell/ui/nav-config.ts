import {
  Bookmark,
  BookOpen,
  Bot,
  Boxes,
  CircleDot,
  ClipboardCheck,
  Database,
  Ellipsis,
  FolderKanban,
  Gavel,
  LayoutDashboard,
  MonitorDown,
  Network,
  Package,
  Puzzle,
  ShieldCheck,
  Store,
  Target,
  Terminal,
  Users,
  UsersRound,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

import { singularSegment } from '@/shared/lib/resource-routes'

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
}

// 섹션에는 접기가 없다 — 헤딩은 라벨이지 버튼이 아니고, 그 아래 줄들은 항상 보인다(워크스페이스 그룹이 그렇듯).
// 접히는 것은 섹션이 아니라 **항목**이다(Workspace › More, 팀 › 평가): 자주 가지 않는 목적지 몇 개를 한 줄
// 뒤로 미루는 것과, 축 하나를 통째로 감추는 것은 다른 일이다. 에이전트는 매일 쓰는 축이라 접힌 채로 시작하던
// 것을 되돌렸다 — 접힌 그룹은 "이 제품에 그런 게 있다"는 사실 자체를 화면에서 지운다.

// Issues are NOT a top-level entry: every issue carries a required `teamId` and its identifier is minted by the
// team (`ENG-123`), so the team is where issues live, not a filter over a global list. Each team in the sidebar's
// "Your teams" group owns its Issues (and a team-scoped Projects view) — see TeamsNav in sidebar.tsx. The
// `/issues` route still exists (workspace-wide, reachable by URL and from the command palette); it just is not
// the way you navigate to work, which is what made the team axis invisible before.
// The sidebar leads with the TRACKER (docs/tracker.md) — Initiative ⊃ Project ⊃ Issue. That is the deliberate
// order of the product's questions: "why are we evaluating this, and can we ship" comes first, and the eval
// The second group is the AGENT — what it can use and what it knows. Tools · skills · knowledge were
// Settings pages, which made them read as one-time configuration; they are none of that, they are the working
// material of the agent and belong beside it. Their pages MOVED out of /settings rather than being copied, so the
// product still has exactly one Skills page and one Tools page.
// The third group is EVALUATION — the primitives that answer "what ran, against what, judged how". They carry an
// owning team in the registry (`team_id`), and for a while that made the team their sidebar home; it doesn't any
// more. A team owns them the way it owns a document — it decides who may CHANGE one — but nobody looks for a
// harness by first choosing a team, and four collections repeated under every team turned the team group into a
// wall. So there is ONE address per collection, and "our team's only" is a filter on it (the `team` facet), which
// is what a narrowing of one list should have been all along.
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
  // Workspace — what spans every team. Initiatives group projects; a project spans teams (it NAMES them, at
  // least one, so this list and a team's are two addresses onto one collection); Views are the saved analysis
  // lenses. `More` holds the workspace rosters, which
  // are configuration screens you visit rarely — they live under /settings and are LINKED here rather than moved,
  // so there is exactly one Members page in the product.
  {
    headingKey: 'workspaceGroup',
    items: [
      {
        href: '/initiatives',
        labelKey: 'initiatives',
        icon: Target,
        keywords: 'initiative release readiness ship 이니셔티브 릴리스 준비',
      },
      {
        href: '/products',
        labelKey: 'products',
        icon: Package,
        keywords: 'product release timeline version ship github 프로덕트 제품 릴리스 버전 타임라인',
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
      // These are APP routes, not /settings ones: looking up a team or a person is reading, and reading should
      // not hand the sidebar over to configuration. The settings pages still exist and own the other half —
      // /teams and /members browse (teams:read · members:read, viewer+), Settings creates·renames·invites·
      // changes roles (teams:write · members:write, admin). Each links to the other for whoever may do both.
      {
        href: '/members',
        labelKey: 'more',
        icon: Ellipsis,
        keywords: 'more member team roster 더보기 멤버 팀',
        children: [
          {
            href: '/members',
            labelKey: 'members',
            icon: Users,
            keywords: 'member people directory who 멤버 사람 디렉토리',
          },
          {
            href: '/teams',
            labelKey: 'teams',
            icon: UsersRound,
            keywords: 'team directory browse key 팀 목록',
          },
        ],
      },
    ],
  },
  // Evaluation — the order is the sentence: what agent (harness), against what (dataset), judged how (judge),
  // and what came back (scorecard). The result sits last because it is the only one you arrive at rather than
  // author.
  {
    headingKey: 'evaluation',
    items: [
      {
        href: '/harnesses',
        labelKey: 'harnesses',
        icon: Boxes,
        keywords: 'harness agent under test cli command service 하네스 하니스 에이전트',
      },
      {
        href: '/datasets',
        labelKey: 'datasets',
        icon: Database,
        keywords: 'dataset benchmark case suite eval 데이터셋 벤치마크 케이스',
      },
      {
        href: '/judges',
        labelKey: 'judges',
        icon: Gavel,
        keywords: 'judge rubric grader verdict llm 저지 평가자 채점 루브릭',
      },
      {
        href: '/scorecards',
        labelKey: 'scorecards',
        icon: ClipboardCheck,
        keywords: 'scorecard batch eval result regression pass rate 스코어카드 배치 평가 결과',
      },
      {
        href: '/reliability',
        labelKey: 'reliability',
        icon: ShieldCheck,
        keywords:
          'reliability trust flake gate audit infra failure sla ops 신뢰성 플레이크 게이트 감사 안정성',
      },
    ],
  },
  {
    headingKey: 'agent',
    items: [
      {
        href: '/tools',
        labelKey: 'tools',
        icon: Wrench,
        keywords: 'tool mcp code capability function 도구 기능',
      },
      {
        href: '/skills',
        labelKey: 'skills',
        icon: BookOpen,
        keywords: 'skill playbook recipe instruction 스킬 지침',
      },
      {
        href: '/knowledge',
        labelKey: 'knowledge',
        icon: Network,
        keywords: 'knowledge graph entry claim lineage 지식 그래프',
      },
      {
        href: '/store',
        labelKey: 'store',
        icon: Store,
        keywords: 'store capability tool mcp code skill adopt publish marketplace 도구 스토어',
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

// The agent fleet has no sidebar row for now: a permanent row is a promise that there is a day's work behind it,
// and authoring an agent is still a thin surface. It keeps its palette entry and its route — whoever already
// works with agents loses nothing — and the row comes back to the `agent` group when the authoring flow can
// carry it. Its working material (tools · skills · knowledge) stays in the sidebar either way, because those are
// what the agent uses no matter where it was created.
const AGENTS_ITEM: NavItem = {
  href: '/agents',
  labelKey: 'agents',
  icon: Bot,
  keywords: 'agent fleet run trigger automation 에이전트 자동화 플릿',
}

export const ALL_NAV_ITEMS: NavItem[] = [
  // children 까지 평탄화 — 펼치지 않아도 Cmd+K 로는 닿아야 한다.
  ...NAV_SECTIONS.flatMap((s) => s.items.flatMap((item) => item.children ?? [item])),
  WORKSPACE_ISSUES_ITEM,
  AGENTS_ITEM,
]

// Every row rendered in the app nav, flattened — the sidebar's `More` children included. The active-state
// invariant ("at most one row") is stated over this list, so a new section can never quietly escape it.
export const ALL_SIDEBAR_ROWS: NavItem[] = [...NAV_SECTIONS, RESOURCES_SECTION].flatMap((section) =>
  section.items.flatMap((item) => item.children ?? [item])
)

// Which row owns the current path — the ONE place the app nav answers that, so no two rows can both claim it.
//
// A row owns its href and everything under it.
export function isNavItemActive(
  item: Pick<NavItem, 'href' | 'exact'>,
  pathname: string,
  workspace: string
): boolean {
  const full = `/${workspace}${item.href}`
  if (item.exact === true) return pathname === full
  if (pathname === full || pathname.startsWith(`${full}/`)) return true
  // A DETAIL page belongs to its collection's row. The nav points at the plural (`/scorecards`) while one
  // scorecard lives at the singular (`/scorecard/{id}`), so a prefix test alone leaves every detail page with no
  // row lit at all — the row goes dark exactly when the user has drilled into it.
  const singular = singularSegment(item.href.replace(/^\//, ''))
  if (singular === undefined) return false
  const detail = `/${workspace}/${singular}`
  return pathname === detail || pathname.startsWith(`${detail}/`)
}
