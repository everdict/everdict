'use client'

import { useState, type ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { GithubAppManager, type GithubAppNotice } from '@/features/manage-github-app'
import { ImageRegistryManager } from '@/features/manage-image-registry'
import { MattermostManager } from '@/features/manage-mattermost'
import { TraceSinkManager } from '@/features/manage-trace-sink'
import { TraceSourceManager } from '@/features/manage-trace-source'
import type { GithubAppView } from '@/entities/github-app'
import type { ImageRegistryConfig } from '@/entities/image-registry'
import type { MattermostConfig } from '@/entities/mattermost'
import type { TraceSinkConfig } from '@/entities/trace-sink'
import type { TraceSourceConfig } from '@/entities/trace-source'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'

export type IntegrationKey =
  | 'github'
  | 'mattermost'
  | 'trace-sink'
  | 'trace-source'
  | 'image-registry'

// Integrations tab — instead of stacking all four managers expanded, a list of one-line per-integration summaries (connection-status badge)
// drills into just that integration via "Manage". If there's a GitHub App installation callback just fired (githubAppNotice) or a ?app= deep link,
// open that integration's detail directly.
export function IntegrationsPanel({
  githubApp,
  githubAppNotice,
  mattermost,
  traceSinks,
  traceSources,
  imageRegistries,
  canWrite,
  secretNames,
  initialActive,
}: {
  githubApp: GithubAppView
  githubAppNotice?: GithubAppNotice
  mattermost?: MattermostConfig
  traceSinks: TraceSinkConfig[]
  traceSources: TraceSourceConfig[]
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
      key: 'trace-source',
      label: t('traceSourceLabel'),
      hint: t('traceSourceHint'),
      status:
        traceSources.length > 0 ? (
          <Badge tone="success">{t('registeredCount', { count: traceSources.length })}</Badge>
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
      {active === 'trace-source' && (
        <TraceSourceManager
          sources={traceSources}
          canWrite={canWrite}
          secretNames={secretNames}
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
