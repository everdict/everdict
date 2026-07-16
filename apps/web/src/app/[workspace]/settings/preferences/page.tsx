import { getTranslations } from 'next-intl/server'

import { PageHeader } from '@/shared/ui/page-header'
import { SettingsColumn } from '@/shared/ui/settings-column'

import { PreferencesPanel } from './preferences-panel'

export const dynamic = 'force-dynamic'

// Account › Preferences — theme + language (per-device). No server data.
export default async function PreferencesPage() {
  const t = await getTranslations('settingsNav')
  return (
    <SettingsColumn>
      <PageHeader title={t('preferences')} description={t('preferencesDesc')} />
      <PreferencesPanel />
    </SettingsColumn>
  )
}
