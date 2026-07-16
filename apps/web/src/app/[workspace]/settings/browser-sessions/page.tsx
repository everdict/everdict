import { getTranslations } from 'next-intl/server'

import { InteractiveBrowserPanel } from '@/features/interactive-browser'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

interface SessionView {
  id: string
  status: string
}

// Settings › Account › Browser sessions — a personal interactive browser the user drives live over a WebSocket
// (browser-profiles S1). Self-scoped (owner = the signed-in user); at most one active session at a time. Profiles
// (login capture + reuse in evals) build on this in later slices.
export default async function BrowserSessionsPage() {
  const t = await getTranslations('interactiveBrowser')
  const ctx = await authContext()

  let initialSession: SessionView | null = null
  try {
    const { sessions } = await controlPlane.listBrowserSessions<{ sessions: SessionView[] }>(ctx)
    initialSession = sessions.find((s) => s.status === 'active') ?? null
  } catch {
    // Browser sessions may not be configured (managed deployments enable a provisioner) — render the launcher; a
    // start attempt then surfaces the 404 as an inline error.
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      <InteractiveBrowserPanel initialSession={initialSession} />
    </div>
  )
}
