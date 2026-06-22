import { AppShell } from '@/widgets/app-shell'
import { currentPrincipal } from '@/shared/auth/principal'
import { keycloakConfigured } from '@/shared/config/env'

export const dynamic = 'force-dynamic'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { principal } = await currentPrincipal()
  return (
    <AppShell
      workspace={principal?.workspace ?? '—'}
      workspaces={principal?.workspaces ?? []}
      roles={principal?.roles ?? []}
      authed={principal?.via === 'oidc'}
      showLogin={keycloakConfigured}
    >
      {children}
    </AppShell>
  )
}
