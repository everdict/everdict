import { getTranslations } from 'next-intl/server'

import { BrowserProfilesManager } from '@/features/manage-browser-profiles'
import { browserProfilesSchema, type BrowserProfile } from '@/entities/browser-profile'
import { can } from '@/shared/auth/can'
import { authContext, currentPrincipal } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Settings › Browser › Browser profiles — workspace-shared saved logins (browser-profiles). A shared workspace asset:
// every member sees the workspace's profiles; the creator or a workspace admin manages each one. Creating a profile
// is session-first: a live browser opens in the wizard, the user logs into the sites the profile should carry
// (optionally through a per-country egress proxy), and finishing captures the cookies. Admins (settings:write) manage
// the workspace proxy pool inline from the wizard's geo step (also its own Settings › Browser › Proxies page).
export default async function BrowserProfilesPage() {
  const t = await getTranslations('browserProfiles')
  const { principal } = await currentPrincipal()
  const ctx = await authContext()

  let profiles: BrowserProfile[] = []
  try {
    profiles = browserProfilesSchema.parse(await controlPlane.listBrowserProfiles(ctx))
  } catch {
    // Browser profiles may not be configured — render the manager with an empty list; a create attempt surfaces it.
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('description')} />
      <BrowserProfilesManager
        initialProfiles={profiles}
        currentSubject={principal?.subject ?? ''}
        canManageAll={principal?.roles.includes('admin') ?? false}
        canManageProxies={can(principal?.roles, 'settings:write')}
      />
    </div>
  )
}
