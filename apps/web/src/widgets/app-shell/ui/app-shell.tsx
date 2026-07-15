import type { ReactNode } from 'react'

import type { Workspace } from '@/entities/workspace'

import { CommandPalette } from './command-palette'
import { PageTransition } from './page-transition'
import { Sidebar } from './sidebar'
import { TopControls } from './top-controls'

// Shared dashboard shell — left sectioned sidebar (workspace switcher + Cmd+K + nav + footer user menu) + body.
// No global top bar on desktop (Linear-style): each page owns its own PageHeader. The only always-present chrome is the
// floating top-right control cluster (notifications + work panel; TopControls) and, on mobile, a slim top bar (from the sidebar).
// The authority for workspace·roles·workspaces·subject is the control plane's GET /me (the web does not decode the token).
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
        {/* md:pt-12 = 데스크톱에서 떠 있는 우상단 클러스터가 페이지 헤더의 우측 액션과 겹치지 않도록 상단 여백 확보(모바일은 상단 바가 이미 아래로 밀어줌). */}
        <div className="mx-auto w-full max-w-[1180px] flex-1 px-5 pb-7 pt-7 text-[13px] sm:px-7 md:pt-12">
          <PageTransition>{children}</PageTransition>
        </div>
      </main>
      <CommandPalette workspace={workspace} />
      <TopControls workspace={workspace} />
    </div>
  )
}
