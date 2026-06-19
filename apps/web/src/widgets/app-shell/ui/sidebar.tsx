'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { BarChart3, Boxes, Database, FlaskConical, Gavel, LayoutDashboard, Server } from 'lucide-react'

import { cn } from '@/shared/lib/utils'

const NAV = [
  { href: '/dashboard', label: '개요', icon: LayoutDashboard, exact: true },
  { href: '/dashboard/runs', label: 'Runs', icon: LayoutDashboard, exact: false },
  { href: '/dashboard/datasets', label: '데이터셋', icon: Database, exact: false },
  { href: '/dashboard/scorecards', label: '스코어카드', icon: BarChart3, exact: false },
  { href: '/dashboard/judges', label: 'Judge', icon: Gavel, exact: false },
  { href: '/dashboard/harnesses', label: '하니스', icon: Boxes, exact: false },
  { href: '/dashboard/runtimes', label: '런타임', icon: Server, exact: false },
] as const

export function Sidebar() {
  const pathname = usePathname()
  return (
    <aside className="hidden w-60 shrink-0 flex-col gap-1 border-r bg-card/40 p-4 md:flex">
      <Link href="/dashboard" className="mb-4 flex items-center gap-2 px-2">
        <span className="grid size-8 place-items-center rounded-xl bg-primary text-primary-foreground">
          <FlaskConical className="size-4" />
        </span>
        <span className="text-lg font-bold tracking-tight">Assay</span>
      </Link>
      {NAV.map((item) => {
        const active = item.exact ? pathname === item.href : pathname.startsWith(item.href)
        const Icon = item.icon
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium transition-colors',
              active
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            )}
          >
            <Icon className="size-4" />
            {item.label}
          </Link>
        )
      })}
    </aside>
  )
}
