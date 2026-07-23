import { getTranslations } from 'next-intl/server'

import { ProxiesManager, proxyListResponseSchema, type ProxyView } from '@/features/manage-proxies'
import { can } from '@/shared/auth/can'
import { authContext, currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Settings › Browser › Proxies — workspace BYO egress proxies (browser-profiles S4) for the interactive login
// browser (and browser evals, S5). A shared workspace asset: reads are a workspace read (any member picks a geo);
// registering/removing is admin (settings:write) — the manager hides its editor for non-admins.
export default async function ProxiesPage() {
  const t = await getTranslations('proxies')
  const { principal } = await currentPrincipal()
  const ctx = await authContext()

  let proxies: ProxyView[] = []
  try {
    proxies = proxyListResponseSchema.parse(await controlPlane.listProxies(ctx)).proxies
  } catch {
    // Proxies may not be configured — render the manager with an empty list; a create attempt surfaces it.
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      <ProxiesManager initialProxies={proxies} canManage={can(principal?.roles, 'settings:write')} />
    </div>
  )
}
