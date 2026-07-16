'use client'

import { useTranslations } from 'next-intl'

import { LocaleSwitcher } from '@/features/switch-locale'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { ThemeToggle } from '@/shared/ui/theme-toggle'

// Account › Preferences — device-local appearance + language, moved out of the sidebar footer.
// Theme lives in localStorage + the html.dark class; language is a cookie. Both are per-device (no server state).
export function PreferencesPanel() {
  const t = useTranslations('preferencesPage')
  return (
    <SettingsList>
      <SettingsRow label={t('themeLabel')} hint={t('themeHint')}>
        <ThemeToggle />
      </SettingsRow>
      <SettingsRow label={t('languageLabel')} hint={t('languageHint')}>
        <LocaleSwitcher variant="compact" />
      </SettingsRow>
    </SettingsList>
  )
}
