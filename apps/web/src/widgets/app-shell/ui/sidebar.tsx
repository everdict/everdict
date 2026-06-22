'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Activity,
  BarChart3,
  Boxes,
  Database,
  FileText,
  FlaskConical,
  Gavel,
  KeyRound,
  LayoutDashboard,
  Server,
  Settings,
  UserCog,
} from 'lucide-react'

import { WorkspaceSwitcher } from '@/widgets/workspace-switcher'
import type { Workspace } from '@/entities/workspace'
import { cn } from '@/shared/lib/utils'

const NAV = [
  { href: '/dashboard', label: '개요', icon: LayoutDashboard, exact: true },
  { href: '/dashboard/runs', label: 'Runs', icon: Activity, exact: false },
  { href: '/dashboard/datasets', label: '데이터셋', icon: Database, exact: false },
  { href: '/dashboard/scorecards', label: '스코어카드', icon: BarChart3, exact: false },
  { href: '/dashboard/report', label: '리포트', icon: FileText, exact: false },
  { href: '/dashboard/judges', label: 'Judge', icon: Gavel, exact: false },
  { href: '/dashboard/harnesses', label: '하니스', icon: Boxes, exact: false },
  { href: '/dashboard/runtimes', label: '런타임', icon: Server, exact: false },
  { href: '/dashboard/secrets', label: '시크릿', icon: KeyRound, exact: false },
  { href: '/dashboard/settings', label: '설정', icon: Settings, exact: false },
  { href: '/dashboard/account', label: '계정', icon: UserCog, exact: false },
] as const

export function Sidebar({ workspace, workspaces }: { workspace: string; workspaces: Workspace[] }) {
  const pathname = usePathname()
  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-0.5 border-r border-border/70 px-3 py-4 md:flex">
      <Link href="/dashboard" className="mb-3 flex items-center gap-2.5 px-2 py-1">
        <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground shadow-[0_0_0_1px_rgba(255,255,255,0.12)_inset,0_6px_18px_-6px_var(--primary)]">
          <FlaskConical className="size-[18px]" />
        </span>
        <span className="text-[15px] font-semibold tracking-tight">Assay</span>
      </Link>
      <WorkspaceSwitcher current={workspace} workspaces={workspaces} />
      {NAV.map((item) => {
        const active = item.exact ? pathname === item.href : pathname.startsWith(item.href)
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
            )}
          >
            <span
              className={cn(
                'absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary transition-opacity',
                active ? 'opacity-100' : 'opacity-0'
              )}
            />
            <Icon
              className={cn(
                'size-[18px] transition-colors',
                active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'
              )}
            />
            {item.label}
          </Link>
        )
      })}
    </aside>
  )
}
