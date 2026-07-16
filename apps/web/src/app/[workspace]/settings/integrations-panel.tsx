'use client'

import { useState, type ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { GithubAppManager, type GithubAppNotice } from '@/features/manage-github-app'
import { ImageRegistryManager } from '@/features/manage-image-registry'
import { MattermostManager } from '@/features/manage-mattermost'
import type { GithubAppView } from '@/entities/github-app'
import type { ImageRegistryConfig } from '@/entities/image-registry'
import type { MattermostConfig } from '@/entities/mattermost'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'

export type IntegrationKey = 'github' | 'mattermost' | 'image-registry'

// Integrations tab — instead of stacking all four managers expanded, a list of one-line per-integration summaries (connection-status badge)
// drills into just that integration via "Manage". If there's a GitHub App installation callback just fired (githubAppNotice) or a ?app= deep link,
// open that integration's detail directly.
export function IntegrationsPanel({
  githubApp,
  githubAppNotice,
  mattermost,
  imageRegistries,
  canWrite,
  secretNames,
  initialActive,
}: {
  githubApp: GithubAppView
  githubAppNotice?: GithubAppNotice
  // Mattermost status: host = operator env server URL (absent = unavailable); config = the workspace registration.
  mattermost?: { host?: string; config?: MattermostConfig }
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
      status:
        mattermost?.config && mattermost.host ? (
          <Badge tone="success">{t('mattermostConnected', { host: mattermost.host })}</Badge>
        ) : (
          <Badge tone="outline">{t('notConnected')}</Badge>
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

  // Default view — per-integration summary rows in a single Linear settings-list.
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

  // Drill-in view — back link + only that integration's manager.
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
          {...(githubAppNotice !== undefined ? { notice: githubAppNotice } : {})}
        />
      )}
      {active === 'mattermost' && (
        <MattermostManager
          canWrite={canWrite}
          secretNames={secretNames}
          {...(mattermost?.host !== undefined ? { serverHost: mattermost.host } : {})}
          {...(mattermost?.config !== undefined ? { config: mattermost.config } : {})}
        />
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
