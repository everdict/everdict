import type { ReactNode } from 'react'

import type { Workspace } from '@/entities/workspace'

import { CommandPalette } from './command-palette'
import { PageTransition } from './page-transition'
import { Sidebar } from './sidebar'

// Shared dashboard shell — left sectioned sidebar (workspace switcher + Cmd+K + nav + footer user menu) + body.
// No global top bar on desktop (Linear-style): each page owns its own PageHeader. Only mobile gets a slim top bar (rendered by the sidebar).
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
        <div className="mx-auto w-full max-w-[1180px] flex-1 px-5 py-7 text-[13px] sm:px-7">
          <PageTransition>{children}</PageTransition>
        </div>
      </main>
      <CommandPalette workspace={workspace} />
    </div>
  )
}
