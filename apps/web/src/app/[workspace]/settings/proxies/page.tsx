import { getTranslations } from 'next-intl/server'

import { ProxiesManager, type ProxyView } from '@/features/manage-proxies'
import { can } from '@/shared/auth/can'
import { authContext, currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Settings › Workspace › Proxies — BYO egress proxies for the interactive login browser (browser-profiles S4).
// Admin only (settings:write); a session/profile selects a country → the login browser runs through that geo.
export default async function ProxiesPage() {
  const t = await getTranslations('proxies')
  const s = await getTranslations('settingsPage')
  const { principal } = await currentPrincipal()
  const canWrite = can(principal?.roles, 'settings:write')
  const header = <PageHeader title={t('title')} description={t('description')} />
  if (!canWrite) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState title={s('noPermissionTitle')} hint={s('noPermissionHint')} />
      </div>
    )
  }

  let proxies: ProxyView[] = []
  try {
    proxies = (await controlPlane.listProxies<{ proxies: ProxyView[] }>(await authContext())).proxies
  } catch {
    // proxies may not be configured — render the empty manager.
  }

  return (
    <div className="space-y-6">
      {header}
      <ProxiesManager initialProxies={proxies} />
    </div>
  )
}
