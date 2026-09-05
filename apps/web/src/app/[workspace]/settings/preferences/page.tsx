import { getTranslations } from 'next-intl/server'

import { agentModelPreferenceSchema, type AgentModelPreference } from '@/entities/agent-tool'
import { modelsSchema } from '@/entities/model'
import { AgentModelPicker } from '@/features/set-agent-model'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'
import { PageHeader } from '@/shared/ui/page-header'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'

import { PreferencesPanel } from './preferences-panel'

export const dynamic = 'force-dynamic'

// Account › Preferences — the per-device display settings (theme, language, timezone) plus my default agent model, which is stored on the account.
// Only the model is server state, so the cards are split: with "this device" and "my account" mixed into one card there is no way to say how far
// each row follows you.
export default async function PreferencesPage() {
  const t = await getTranslations('settingsNav')
  const a = await getTranslations('agentModelPreference')
  const ctx = await authContext()

  // Both are best-effort — the remaining settings must still show on a deployment with no model registry, and to a member without permission.
  let preference: AgentModelPreference | undefined
  let models: string[] = []
  try {
    ;[preference, models] = await Promise.all([
      controlPlane.getAgentModel(ctx).then((r) => agentModelPreferenceSchema.parse(r)),
      controlPlane
        .listModels(ctx)
        .then((r) => modelsSchema.parse(r).map((m) => m.id))
        .catch(() => []),
    ])
  } catch {
    preference = undefined
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('preferences')} description={t('preferencesDesc')} />
      <PreferencesPanel />
      {preference && (
        <SettingsList>
          <SettingsRow label={a('label')} hint={a('hint')}>
            <AgentModelPicker
              model={preference.model}
              workspaceDefault={preference.workspaceDefault}
              models={models}
            />
          </SettingsRow>
        </SettingsList>
      )}
    </div>
  )
}
