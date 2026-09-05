import {
  Bookmark,
  BookOpen,
  Bot,
  Boxes,
  CircleDot,
  ClipboardCheck,
  Database,
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
  Wrench,
  type LucideIcon,
  FlaskConical,
  Handshake,
  TrendingUp,
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
  // The case where the ITEM itself expands (Linear's Workspace › More). It is the item that opens rather than the section because this is
  // part of the Workspace group — split out as its own section it would leave Workspace entirely.
  children?: NavItem[]
}

export interface NavSection {
  heading?: string
  headingKey?: string // nav.* key — preferred over `heading` (raw) so section titles are localized
  items: NavItem[]
}

// A section does not collapse — a heading is a label rather than a button, and the rows beneath it are always visible (as the workspace group's are).
// What collapses is an **item**, not a section (Workspace › More, Team › Evaluation): pushing a few rarely-visited destinations one row back
// and hiding a whole AXIS are different things. Agents start expanded again, reverting the collapsed default — a collapsed group erases from
// the screen the very fact that the product HAS such a thing.

// Issues ARE a top-level entry. They were not, while a team minted the identifier and owned the list, and the
// sidebar's "Your teams" group was where you found them; the workspace is the only boundary now, so there is
// ONE list and it belongs at the top with the rest of the tracker.
// The sidebar leads with the TRACKER (docs/tracker.md) — Initiative ⊃ Project ⊃ Issue. That is the deliberate
// order of the product's questions: "why are we evaluating this, and can we ship" comes first, and the eval
// The second group is the AGENT — what it can use and what it knows. Tools · skills · knowledge were
// Settings pages, which made them read as one-time configuration; they are none of that, they are the working
// material of the agent and belong beside it. Their pages MOVED out of /settings rather than being copied, so the
// product still has exactly one Skills page and one Tools page.
// The third group is EVALUATION — the primitives that answer "what ran, against what, judged how". ONE address
// per collection. They were scoped under an owning team for a while, which put four collections under every
// team and turned that group into a wall in front of the issues; the workspace is the only boundary now, so
// there is nothing left for a path to scope by.
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
      // An APP route, not a /settings one: looking up a person is reading, and reading should not hand the
      // sidebar over to configuration. The settings page owns the other half — this browses
      // (`members:read`, viewer+), Settings invites and changes roles (`members:write`, admin).
      {
        href: '/members',
        labelKey: 'members',
        icon: Users,
        keywords: 'member people directory who 멤버 사람 디렉토리',
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

// Agent approvals keep the same posture as the fleet row above — palette-reachable, no permanent sidebar
// row — for the opposite reason: the queue is usually EMPTY, and a row that is empty most days trains people
// to stop looking at it. What it must not be is unreachable, which is what it was: the decision existed only
// on the agent surface, so the member the queue exists for had no door.
// docs/architecture/web-runtime-gap-census-spec.md
const APPROVALS_ITEM: NavItem = {
  href: '/approvals',
  labelKey: 'approvals',
  icon: ShieldCheck,
  keywords: 'approval approve deny parked agent mutation hitl human in the loop',
}

// Handoffs keep the approvals posture — palette-reachable, no permanent row. They are evidence somebody
// goes looking for after a task stopped, not a place to live.
const CHECKPOINTS_ITEM: NavItem = {
  href: '/checkpoints',
  labelKey: 'checkpoints',
  icon: Handshake,
  keywords: 'handoff checkpoint agent transfer evidence verification',
}

// Experiments are scorecards that have not been judged yet, so they keep the palette-only posture rather
// than a row beside the scorecard list — two rows for one record is how a reader learns to distrust both.
const EXPERIMENTS_ITEM: NavItem = {
  href: '/experiments',
  labelKey: 'experiments',
  icon: FlaskConical,
  keywords: 'experiment group ungraded phase two judge later',
}

// Evolution campaigns keep the palette-only posture. A campaign is driven by a loop, not by somebody
// clicking through it — what the web owes is a place to AUDIT one and to make the two decisions the record
// asks a person for (settle, and spend the authorization).
const CAMPAIGNS_ITEM: NavItem = {
  href: '/campaigns',
  labelKey: 'campaigns',
  icon: TrendingUp,
  keywords: 'campaign evolution candidate baseline round gate adopt settle',
}

export const ALL_NAV_ITEMS: NavItem[] = [
  // Flattened down to the children too — reachable through Cmd+K even while collapsed.
  ...NAV_SECTIONS.flatMap((s) => s.items.flatMap((item) => item.children ?? [item])),
  WORKSPACE_ISSUES_ITEM,
  AGENTS_ITEM,
  APPROVALS_ITEM,
  CHECKPOINTS_ITEM,
  EXPERIMENTS_ITEM,
  CAMPAIGNS_ITEM,
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
