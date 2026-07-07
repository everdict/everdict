'use client'

import { useState, type ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { GithubAppManager, type GithubAppNotice } from '@/features/manage-github-app'
import { ImageRegistryManager } from '@/features/manage-image-registry'
import { MattermostManager } from '@/features/manage-mattermost'
import { TraceSinkManager } from '@/features/manage-trace-sink'
import type { GithubAppView } from '@/entities/github-app'
import type { ImageRegistryConfig } from '@/entities/image-registry'
import type { MattermostConfig } from '@/entities/mattermost'
import type { TraceSinkConfig } from '@/entities/trace-sink'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'

export type IntegrationKey = 'github' | 'mattermost' | 'trace-sink' | 'image-registry'

// 통합 탭 — 네 매니저를 전부 펼쳐 쌓던 스택 대신, 통합별 한 줄 요약(연결 상태 배지) 리스트에서
// "관리"로 해당 통합만 드릴인한다. GitHub App 설치 콜백 직후(githubAppNotice)나 ?app= 딥링크가
// 있으면 그 통합 상세를 바로 연다.
export function IntegrationsPanel({
  githubApp,
  githubAppNotice,
  mattermost,
  traceSinks,
  imageRegistries,
  canWrite,
  secretNames,
  initialActive,
}: {
  githubApp: GithubAppView
  githubAppNotice?: GithubAppNotice
  mattermost?: MattermostConfig
  traceSinks: TraceSinkConfig[]
  imageRegistries: ImageRegistryConfig[]
  canWrite: boolean
  secretNames: string[]
  initialActive?: IntegrationKey
}) {
  const t = useTranslations('settingsPage')
  const [active, setActive] = useState<IntegrationKey | undefined>(
    initialActive ?? (githubAppNotice ? 'github' : undefined)
  )

  const rows: { key: IntegrationKey; label: string; hint: string; status: ReactNode }[] = [
    {
      key: 'github',
      label: 'GitHub',
      hint: t('githubHint'),
      status:
        githubApp.installations.length > 0 ? (
          <Badge tone="success">
            {t('githubConnected', { count: githubApp.installations.length })}
          </Badge>
        ) : (
          <Badge tone="outline">{t('notConnected')}</Badge>
        ),
    },
    {
      key: 'mattermost',
      label: 'Mattermost',
      hint: t('mattermostHint'),
      status: mattermost ? (
        <Badge tone="success">{t('mattermostConnected', { host: mattermost.host })}</Badge>
      ) : (
        <Badge tone="outline">{t('notConnected')}</Badge>
      ),
    },
    {
      key: 'trace-sink',
      label: t('traceSinkLabel'),
      hint: t('traceSinkHint'),
      status:
        traceSinks.length > 0 ? (
          <Badge tone="success">{t('registeredCount', { count: traceSinks.length })}</Badge>
        ) : (
          <Badge tone="outline">{t('notRegistered')}</Badge>
        ),
    },
    {
      key: 'image-registry',
      label: t('imageRegistryLabel'),
      hint: t('imageRegistryHint'),
      status:
        imageRegistries.length > 0 ? (
          <Badge tone="success">{t('registeredCount', { count: imageRegistries.length })}</Badge>
        ) : (
          <Badge tone="outline">{t('notRegistered')}</Badge>
        ),
    },
  ]

  // 기본 뷰 — Linear settings-list 한 장에 통합별 요약 행.
  if (!active) {
    return (
      <SettingsList>
        {rows.map((r) => (
          <SettingsRow
            key={r.key}
            label={
              <span className="inline-flex flex-wrap items-center gap-2">
                {r.label}
                {r.status}
              </span>
            }
            hint={r.hint}
          >
            <Button variant="secondary" size="xs" onClick={() => setActive(r.key)}>
              {t('manage')}
            </Button>
          </SettingsRow>
        ))}
      </SettingsList>
    )
  }

  // 드릴인 뷰 — 뒤로가기 + 해당 통합의 매니저만.
  return (
    <div className="space-y-5">
      <button
        type="button"
        onClick={() => setActive(undefined)}
        className="inline-flex items-center gap-0.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="size-3.5" />
        {t('tabIntegrations')}
      </button>
      {active === 'github' && (
        <GithubAppManager
          view={githubApp}
          canWrite={canWrite}
          secretNames={secretNames}
          {...(githubAppNotice !== undefined ? { notice: githubAppNotice } : {})}
        />
      )}
      {active === 'mattermost' && (
        <MattermostManager
          canWrite={canWrite}
          secretNames={secretNames}
          {...(mattermost !== undefined ? { config: mattermost } : {})}
        />
      )}
      {active === 'trace-sink' && (
        <TraceSinkManager sinks={traceSinks} canWrite={canWrite} secretNames={secretNames} />
      )}
      {active === 'image-registry' && (
        <ImageRegistryManager
          registries={imageRegistries}
          canWrite={canWrite}
          secretNames={secretNames}
        />
      )}
    </div>
  )
}
