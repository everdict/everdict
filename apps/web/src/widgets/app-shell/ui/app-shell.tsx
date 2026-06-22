import type { ReactNode } from 'react'
import Link from 'next/link'

import type { Workspace } from '@/entities/workspace'
import { Badge } from '@/shared/ui/badge'
import { ThemeToggle } from '@/shared/ui/theme-toggle'

import { Sidebar } from './sidebar'

// 대시보드 공통 셸: 좌측 사이드바(워크스페이스 스위처 + 내비) + 상단 바(역할/인증) + 본문.
// workspace·roles·workspaces 는 컨트롤플레인 GET /me 가 권위(웹은 토큰을 직접 해석하지 않는다).
export function AppShell({
  workspace,
  workspaces,
  roles,
  authed,
  showLogin,
  children,
}: {
  workspace: string // 활성 워크스페이스 id
  workspaces: Workspace[] // 내가 속한 워크스페이스(스위처용)
  roles: string[]
  authed: boolean
  showLogin: boolean
  children: ReactNode
}) {
  return (
    <div className="flex min-h-screen">
      <Sidebar workspace={workspace} workspaces={workspaces} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-border/70 bg-background/70 px-6 backdrop-blur-xl">
          <span className="text-sm font-medium text-muted-foreground md:hidden">Assay</span>
          <div className="ml-auto flex items-center gap-2.5">
            {roles.length > 0 && <Badge tone="neutral">{roles.join(', ')}</Badge>}
            <Badge tone={authed ? 'success' : 'neutral'}>{authed ? 'authenticated' : 'dev'}</Badge>
            <ThemeToggle />
            {showLogin &&
              (authed ? (
                <Link
                  href="/api/auth/signout"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  로그아웃
                </Link>
              ) : (
                <Link
                  href="/api/auth/signin"
                  className="text-sm font-medium text-primary transition-opacity hover:opacity-80"
                >
                  로그인
                </Link>
              ))}
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 space-y-8 px-6 py-9">{children}</main>
      </div>
    </div>
  )
}
