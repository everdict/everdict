import { currentTenant } from '@/shared/auth/tenant'
import { keycloakConfigured } from '@/shared/config/env'
import { AppShell } from '@/widgets/app-shell'

export const dynamic = 'force-dynamic'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { tenant, authed } = await currentTenant()
  return (
    <AppShell tenant={tenant} authed={authed} showLogin={keycloakConfigured}>
      {children}
    </AppShell>
  )
}
