import type { ReactNode } from 'react'

import { WorkPanelProvider, WorkRail } from '@/widgets/work-panel'
import type { Workspace } from '@/entities/workspace'

import { CommandPalette } from './command-palette'
import { PageTransition } from './page-transition'
import { Sidebar } from './sidebar'
import { TopControls } from './top-controls'

// Shared dashboard shell — left sectioned sidebar (workspace switcher + Cmd+K + nav + footer user menu) + body.
// No global top bar on desktop (Linear-style): each page owns its own PageHeader. The only always-present chrome is the
// floating top-right control cluster (notifications + collapsed work summary; TopControls) and, on mobile, a slim top bar.
// The work rail docks as a real right column (WorkRail — sibling of <main>, so an open rail shrinks the content), sharing
// its open-state + polled snapshot with the cluster summary via WorkPanelProvider (which wraps the whole shell).
// The authority for workspace·roles·workspaces·subject is the control plane's GET /me (the web does not decode the token).
export function AppShell({
  workspace,
  workspaces,
  subject,
  roles,
  authed,
  showLogin,
  email,
  profile,
  children,
}: {
  workspace: string
  workspaces: Workspace[]
  subject: string
  roles: string[]
  authed: boolean
  showLogin: boolean
  email?: string
  profile?: { name?: string; username?: string; avatarUrl?: string }
  children: ReactNode
}) {
  return (
    <WorkPanelProvider workspace={workspace}>
      <div className="flex min-h-screen flex-col md:flex-row">
        <Sidebar
          workspace={workspace}
          workspaces={workspaces}
          subject={subject}
          roles={roles}
          authed={authed}
          showLogin={showLogin}
          {...(email !== undefined ? { email } : {})}
          {...(profile !== undefined ? { profile } : {})}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          {/* md:pt-12 = reserve top padding on desktop so the floating top-right cluster doesn't overlap the page header's right-side actions (on mobile the top bar already pushes content down). */}
          <div className="mx-auto w-full max-w-[1180px] flex-1 px-5 pb-7 pt-7 text-[13px] sm:px-7 md:pt-12">
            <PageTransition>{children}</PageTransition>
          </div>
        </main>
        {/* Work rail — when open it docks as the right-hand column here, shrinking main (it must be a sibling of main to take layout space). */}
        <WorkRail />
      </div>
      <CommandPalette workspace={workspace} />
      <TopControls workspace={workspace} />
    </WorkPanelProvider>
  )
}
