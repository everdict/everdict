'use client'

import { useState } from 'react'

import { SecretsManager } from '@/features/manage-workspace-secrets'
import { SettingsForm, type WorkspaceSettings } from '@/features/workspace-settings'
import type { SecretMeta } from '@/entities/secret'
import { cn } from '@/shared/lib/utils'
import { Card } from '@/shared/ui/card'

type TabKey = 'general' | 'model' | 'cluster'

// 워크스페이스 설정 탭: 일반(정책) · 모델 키 · 클러스터 자격증명. 권한 없는 탭은 숨긴다(최종 강제는 컨트롤플레인).
export function SettingsTabs(props: {
  settings: WorkspaceSettings
  secrets: SecretMeta[]
  canReadSettings: boolean
  canWriteSettings: boolean
  canReadSecrets: boolean
  canWriteSecrets: boolean
}) {
  const tabs: { key: TabKey; label: string; show: boolean }[] = [
    { key: 'general', label: '일반', show: props.canReadSettings },
    { key: 'model', label: '모델 키', show: props.canReadSecrets },
    { key: 'cluster', label: '클러스터 자격증명', show: props.canReadSecrets },
  ]
  const visible = tabs.filter((t) => t.show)
  const [active, setActive] = useState<TabKey>(visible[0]?.key ?? 'general')

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b">
        {visible.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActive(t.key)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
              active === t.key
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <Card className="p-6">
        {active === 'general' && (
          <SettingsForm initial={props.settings} canWrite={props.canWriteSettings} />
        )}
        {active === 'model' && (
          <SecretsManager
            variant="model"
            secrets={props.secrets}
            canWrite={props.canWriteSecrets}
          />
        )}
        {active === 'cluster' && (
          <SecretsManager
            variant="cluster"
            secrets={props.secrets}
            canWrite={props.canWriteSecrets}
          />
        )}
      </Card>
    </div>
  )
}
