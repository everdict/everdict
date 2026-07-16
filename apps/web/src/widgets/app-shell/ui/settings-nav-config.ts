import {
  AppWindow,
  Building2,
  Cpu,
  GitBranch,
  KeyRound,
  Lock,
  Plug,
  Server,
  Shield,
  SlidersHorizontal,
  Telescope,
  UserCircle,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'

import type { WebAction } from '@/shared/auth/can'

// Settings secondary-nav — grouped Account (personal, no gate) + Workspace (role-gated). Mirrors nav-config's idiom:
// href is a suffix UNDER /{workspace}/settings (prefixed at render), and labelKey is a settingsNav.* message key.
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
// · Runners = settings:write · Budget = scorecards:read. Account items are ungated (self-scoped).
export const SETTINGS_NAV_GROUPS: SettingsNavGroup[] = [
  {
    headingKey: 'groupAccount',
    items: [
      { href: '/profile', labelKey: 'profile', icon: UserCircle },
      { href: '/preferences', labelKey: 'preferences', icon: SlidersHorizontal },
      { href: '/api-keys', labelKey: 'apiKeys', icon: KeyRound },
      { href: '/personal-secrets', labelKey: 'personalSecrets', icon: Lock },
      { href: '/browser-sessions', labelKey: 'browserSessions', icon: AppWindow },
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
      { href: '/ci', labelKey: 'ci', icon: GitBranch, requiredAction: 'settings:read' },
      { href: '/runners', labelKey: 'runners', icon: Server, requiredAction: 'settings:write' },
      { href: '/budget', labelKey: 'budget', icon: Wallet, requiredAction: 'scorecards:read' },
    ],
  },
]
