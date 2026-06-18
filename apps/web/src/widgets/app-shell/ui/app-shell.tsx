import type { ReactNode } from 'react'

import Link from 'next/link'

import { Badge } from '@/shared/ui/badge'
import { Sidebar } from './sidebar'

// 대시보드 공통 셸: 좌측 사이드바 + 상단 바(워크스페이스/역할/인증) + 본문.
// workspace·roles 는 컨트롤플레인 GET /me 가 권위(웹은 토큰을 직접 해석하지 않는다).
export function AppShell({
  workspace,
  roles,
  authed,
  showLogin,
  children,
}: {
  workspace: string
  roles: string[]
  authed: boolean
  showLogin: boolean
  children: ReactNode
}) {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b bg-background/80 px-6 backdrop-blur">
          <span className="text-sm text-muted-foreground md:hidden">Assay</span>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              workspace <span className="font-mono text-foreground">{workspace}</span>
            </span>
            {roles.length > 0 && <Badge tone="neutral">{roles.join(', ')}</Badge>}
            <Badge tone={authed ? 'success' : 'neutral'}>{authed ? 'authenticated' : 'dev'}</Badge>
            {showLogin &&
              (authed ? (
                <Link href="/api/auth/signout" className="text-sm text-muted-foreground hover:text-foreground">
                  로그아웃
                </Link>
              ) : (
                <Link href="/api/auth/signin" className="text-sm font-medium text-primary hover:opacity-80">
                  로그인
                </Link>
              ))}
          </div>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 space-y-8 px-6 py-8">{children}</main>
      </div>
    </div>
  )
}
