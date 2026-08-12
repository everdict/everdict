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

// Account › Preferences — 기기별 표시 설정(테마·언어·시간대) + 계정에 저장되는 내 기본 에이전트 모델.
// 모델만 서버 상태라 카드를 나눈다: 한 카드 안에서 "이 기기" 와 "내 계정" 이 섞이면 어느 행이 어디까지 따라오는지
// 말할 수 없다.
export default async function PreferencesPage() {
  const t = await getTranslations('settingsNav')
  const a = await getTranslations('agentModelPreference')
  const ctx = await authContext()

  // 둘 다 best-effort — 모델 레지스트리가 없는 배포/권한 없는 멤버에게도 나머지 설정은 계속 보여야 한다.
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
