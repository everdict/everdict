import type { ReactNode } from 'react'

import { InfraPanel, InfraPanelProvider, InfraRail } from '@/widgets/infra-panel'
import { ProductTour } from '@/widgets/product-tour'
import type { Workspace } from '@/entities/workspace'
import { can } from '@/shared/auth/can'

import { CommandPalette } from './command-palette'
import { PageTransition } from './page-transition'
import { Sidebar } from './sidebar'
import { TopControls } from './top-controls'

// Shared dashboard shell — left sectioned sidebar (workspace switcher + Cmd+K + nav + footer user menu) + body.
// No global top bar on desktop (Linear-style): each page owns its own PageHeader. The always-present chrome is the
// floating top-right notification bell (TopControls), the vertical infra rail on the right edge and, on mobile, a slim top bar.
// Infra split view: the rail's vertical buttons (schedules · runtimes · runs · work) open the floating infra panel as a
// flex-1 sibling of main — the eval side (left: routed pages) and the infra side (right: the panel) then split the space
// half-and-half, and the rail sits between them as the divider. Panel state + the polled queue snapshot live in
// InfraPanelProvider (mounted here, above the routes), so left-side navigation never interrupts a run's live stream.
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
  // 대화 패널의 사용자 턴 아바타 — 사이드바 계정 표시와 같은 해석(프로필 이름 > 사용자명 > 이메일 > subject).
  const chatUserName = profile?.name ?? profile?.username ?? email ?? subject
  return (
    <InfraPanelProvider workspace={workspace}>
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
        {/* md:basis-0 pairs with the panel's flex-1 basis-0 — when the infra panel is open the two split the remaining space 50:50. */}
        <main className="flex min-w-0 flex-1 flex-col md:basis-0">
          {/* md:pt-12 = reserve top padding on desktop so the floating top-right cluster doesn't overlap the page header's right-side actions (on mobile the top bar already pushes content down). */}
          <div className="mx-auto w-full max-w-[1180px] flex-1 px-5 pb-7 pt-7 text-[13px] sm:px-7 md:pt-12">
            <PageTransition>{children}</PageTransition>
          </div>
        </main>
        {/* Infra split view — the rail (divider) + the floating panel must be siblings of main to take layout space. */}
        <InfraRail />
        <InfraPanel
          user={{
            name: chatUserName,
            ...(profile?.avatarUrl !== undefined ? { avatarUrl: profile.avatarUrl } : {}),
          }}
          canFilesWrite={can(roles, 'files:write')}
        />
      </div>
      <CommandPalette workspace={workspace} />
      <TopControls workspace={workspace} />
      {/* 신규 유저 온보딩 투어 — 사이드바 크롬을 짚어가며 안내. AppShell 에 마운트되어 라우트 전환에도 상태 유지(비-embed 셸에서만). */}
      <ProductTour workspace={workspace} />
    </InfraPanelProvider>
  )
}
