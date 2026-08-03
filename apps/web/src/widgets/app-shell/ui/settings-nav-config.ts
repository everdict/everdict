import { Boxes, Building2, Container, Cpu, Fingerprint, GitBranch, Globe, HardDrive, KeyRound, Lock, Plug, Shield, SlidersHorizontal, Sparkles, Tag, Telescope, UserCircle, Users, UsersRound, Wallet, Zap, type LucideIcon } from 'lucide-react'

import type { WebAction } from '@/shared/auth/can'

// Settings secondary-nav — grouped Account (personal, no gate) + Workspace (role-gated) + Agent + Browser (both
// workspace-scoped eval env). The Agent and Browser groups are the home for evaluation-specialized config that fits
// neither generic personal account nor generic workspace ops: the workspace assistant (instructions + skills + tools +
// model) and browse-use browser tooling (saved login profiles + egress proxies), shared at the workspace scope.
// Mirrors nav-config's idiom: href is a suffix UNDER /{workspace}/settings (prefixed at render), and labelKey is a
// settingsNav.* message key.
export interface SettingsNavItem {
  href: string // '' = General index, '/profile', … (suffix under /settings)
  labelKey: string // settingsNav.* key
  icon: LucideIcon
  requiredAction?: WebAction // undefined = always shown (personal account items)
  exact?: boolean // exact-match active state (only the General index needs it)
}

export interface SettingsNavGroup {
  headingKey: string // settingsNav.* group heading key
  items: SettingsNavItem[]
}

// Gates mirror the former settings-tabs.tsx `show:` flags exactly:
// General/Integrations/CI = settings:read · Members = members:read · Secrets = secrets:read · Models = models:read
// · Budget = scorecards:read. Account items are ungated (self-scoped).
// (Team shared runners moved to the Runtimes surface — a runner is one flavor of execution runtime, not a settings tab.)
export const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    headingKey: 'groupAccount',
    items: [
      { href: '/profile', labelKey: 'profile', icon: UserCircle },
      { href: '/preferences', labelKey: 'preferences', icon: SlidersHorizontal },
      { href: '/api-keys', labelKey: 'apiKeys', icon: KeyRound },
      { href: '/personal-secrets', labelKey: 'personalSecrets', icon: Lock },
    ],
  },
  {
    headingKey: 'groupWorkspace',
    items: [
      {
        href: '',
        labelKey: 'general',
        icon: Building2,
        requiredAction: 'settings:read',
        exact: true,
      },
      { href: '/members', labelKey: 'members', icon: Users, requiredAction: 'members:read' },
      { href: '/teams', labelKey: 'teams', icon: UsersRound, requiredAction: 'teams:read' },
      // 트래커 어휘 — 팀 바로 아래. 권한은 이슈와 같은 쌍을 쓴다(별도 표면이 아니다).
      { href: '/labels', labelKey: 'labels', icon: Tag, requiredAction: 'issues:read' },
      { href: '/secrets', labelKey: 'secrets', icon: Shield, requiredAction: 'secrets:read' },
      { href: '/models', labelKey: 'models', icon: Cpu, requiredAction: 'models:read' },
      {
        href: '/integrations',
        labelKey: 'integrations',
        icon: Plug,
        requiredAction: 'settings:read',
      },
      {
        href: '/observability',
        labelKey: 'observability',
        icon: Telescope,
        requiredAction: 'harnesses:read',
      },
      // Workspace-owned eval-environment images (author/version) + the imported-environment inventory. Eval infra,
      // not agent config — so it sits with the workspace ops, not in the Agent group.
      {
        href: '/environments',
        labelKey: 'environments',
        icon: Container,
        requiredAction: 'capabilities:read',
      },
      // 관리형 이미지 스토어의 워크스페이스 네임스페이스 — 우리가 저장하고 grant를 발급하는 이미지들.
      // BYO 레지스트리(Integrations)와 다른 화면인 이유는 소유 관계가 다르기 때문이다.
      { href: '/images', labelKey: 'images', icon: Boxes, requiredAction: 'harnesses:read' },
      // The workspace filesystem's governance view (usage + cleanup) — in-service, never the object-storage console.
      { href: '/files', labelKey: 'files', icon: HardDrive, requiredAction: 'files:read' },
      { href: '/ci', labelKey: 'ci', icon: GitBranch, requiredAction: 'settings:read' },
      { href: '/budget', labelKey: 'budget', icon: Wallet, requiredAction: 'scorecards:read' },
    ],
  },
  {
    // Evaluation-specialized workspace env — the workspace assistant as ONE concern: the agent's config, the tools it
    // Settings keeps the agent's CONFIGURATION (its spec, and the event→reaction subscriptions that wake it).
    // Its working material — tools, skills, knowledge — moved to the sidebar's Agent group: those are things
    // you author and consult while working, not settings you set once.
    headingKey: 'groupAgent',
    items: [
      { href: '/agent', labelKey: 'agent', icon: Sparkles, requiredAction: 'agents:read' },
      // The E3 registry — event → reaction rules (wake an agent · signed webhook · durable chain).
      {
        href: '/subscriptions',
        labelKey: 'subscriptions',
        icon: Zap,
        requiredAction: 'agents:read',
      },
    ],
  },
  {
    // Evaluation-specialized workspace env — browse-use browser tooling. Reads are workspace reads (any member sees
    // the shared profiles/proxies to pick from); writes are gated in-page (profiles = creator-or-admin, proxies =
    // admin), so the nav items themselves stay ungated.
    headingKey: 'groupBrowser',
    items: [
      { href: '/browser-profiles', labelKey: 'browserProfiles', icon: Fingerprint },
      { href: '/proxies', labelKey: 'proxies', icon: Globe },
    ],
  },
]
