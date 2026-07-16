import { getTranslations } from 'next-intl/server'

import { type BrowserProfile, browserProfilesSchema } from '@/entities/browser-profile'
import { BrowserProfilesManager } from '@/features/manage-browser-profiles'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { PageHeader } from '@/shared/ui/page-header'

export const dynamic = 'force-dynamic'

// Settings › Account › Browser profiles — personal saved logins (browser-profiles S2). Self-scoped (owner = the
// signed-in user). Cookie capture (S3) and eval injection (S5) build on these.
export default async function BrowserProfilesPage() {
  const t = await getTranslations('browserProfiles')
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
      <BrowserProfilesManager initialProfiles={profiles} />
    </div>
  )
}
