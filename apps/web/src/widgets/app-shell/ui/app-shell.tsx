import type { ReactNode } from 'react'

import type { Workspace } from '@/entities/workspace'

import { CommandPalette } from './command-palette'
import { PageTransition } from './page-transition'
import { Sidebar } from './sidebar'

// 대시보드 공통 셸 — 좌측 섹션형 사이드바(워크스페이스 스위처 + Cmd+K + 내비 + 푸터 유저메뉴) + 본문.
// 데스크톱엔 글로벌 상단 바 없음(Linear 식): 페이지가 자체 PageHeader 를 소유한다. 모바일만 슬림 상단 바(사이드바가 렌더).
// workspace·roles·workspaces·subject 의 권위는 컨트롤플레인 GET /me (웹은 토큰을 해석하지 않는다).
export function AppShell({
  workspace,
  workspaces,
  subject,
  roles,
  authed,
  showLogin,
  children,
}: {
  workspace: string
  workspaces: Workspace[]
  subject: string
  roles: string[]
  authed: boolean
  showLogin: boolean
  children: ReactNode
}) {
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Sidebar
        workspace={workspace}
        workspaces={workspaces}
        subject={subject}
        roles={roles}
        authed={authed}
        showLogin={showLogin}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="mx-auto w-full max-w-[1180px] flex-1 px-5 py-7 text-[13px] sm:px-7">
          <PageTransition>{children}</PageTransition>
        </div>
      </main>
      <CommandPalette />
    </div>
  )
}
