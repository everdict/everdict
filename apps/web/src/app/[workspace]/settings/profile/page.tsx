import { getTranslations } from 'next-intl/server'

import { LeaveWorkspaceButton } from '@/features/leave-workspace'
import { ProfileForm } from '@/features/update-profile'
import { currentPrincipal } from '@/shared/auth/principal'
import { EmptyState } from '@/shared/ui/empty-state'
import { PageHeader } from '@/shared/ui/page-header'
import { SettingsColumn } from '@/shared/ui/settings-column'

export const dynamic = 'force-dynamic'

// Account › Profile — edit name/avatar (self-scoped, no role gate) + leave the active workspace.
export default async function ProfilePage() {
  const t = await getTranslations('settingsNav')
  const { principal } = await currentPrincipal()
  if (!principal) {
    const a = await getTranslations('accountPage')
    return (
      <SettingsColumn>
        <PageHeader title={t('profile')} description={t('profileDesc')} />
        <EmptyState title={a('signedOutTitle')} hint={a('signedOutHint')} />
      </SettingsColumn>
    )
  }

  return (
    <SettingsColumn>
      <PageHeader title={t('profile')} description={t('profileDesc')} />
      <div className="space-y-5">
        <ProfileForm
          email={principal.email}
          name={principal.profile?.name}
          avatarUrl={principal.profile?.avatarUrl}
        />
        {/* Leave workspace — based on the active workspace (hidden for api-key sessions). */}
        {principal.via === 'oidc' && principal.workspace && <LeaveWorkspaceButton />}
      </div>
    </SettingsColumn>
  )
}
