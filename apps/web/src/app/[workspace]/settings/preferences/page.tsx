import { getTranslations } from 'next-intl/server'

import { PageHeader } from '@/shared/ui/page-header'

import { PreferencesPanel } from './preferences-panel'

export const dynamic = 'force-dynamic'

// Account › Preferences — theme + language (per-device). No server data.
export default async function PreferencesPage() {
  const t = await getTranslations('settingsNav')
  return (
    <div className="space-y-6">
      <PageHeader title={t('preferences')} description={t('preferencesDesc')} />
      <div className="max-w-2xl">
        <PreferencesPanel />
      </div>
    </div>
  )
}
