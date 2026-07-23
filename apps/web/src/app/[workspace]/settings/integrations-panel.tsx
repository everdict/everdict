'use client'

import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { GithubAppManager, type GithubAppNotice } from '@/features/manage-github-app'
import { ImageRegistryManager } from '@/features/manage-image-registry'
import { MattermostManager } from '@/features/manage-mattermost'
import type { GithubAppView } from '@/entities/github-app'
import type { ImageRegistryConfig } from '@/entities/image-registry'
import type { MattermostConfig } from '@/entities/mattermost'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { SettingsList } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

export type IntegrationKey = 'github' | 'mattermost' | 'image-registry'

// Integrations tab — one-line per-integration summary rows (connection-status badge); "Manage" expands that
// integration's manager IN PLACE below the row (single-open accordion) instead of swapping the whole list for a
// drill-in view — no page-navigation feel, the other integrations stay visible. If a GitHub App installation
// callback just fired (githubAppNotice) or a ?app= deep link is present, that row starts expanded.
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
  const tGithub = useTranslations('manageGithubApp')
  const tMattermost = useTranslations('manageMattermost')
  const tRegistry = useTranslations('manageImageRegistry')
  const [active, setActive] = useState<IntegrationKey | undefined>(
    initialActive ?? (githubAppNotice ? 'github' : undefined)
  )

  const rows: {
    key: IntegrationKey
    label: string
    tip: ReactNode
    hint: string
    status: ReactNode
    detail: ReactNode
  }[] = [
    {
      key: 'github',
      label: 'GitHub',
      tip: tGithub('titleTip'),
      hint: t('githubHint'),
      status:
        githubApp.installations.length > 0 ? (
          <Badge tone="success">
            {t('githubConnected', { count: githubApp.installations.length })}
          </Badge>
        ) : (
          <Badge tone="outline">{t('notConnected')}</Badge>
        ),
      detail: (
        <GithubAppManager
          view={githubApp}
          canWrite={canWrite}
          {...(githubAppNotice !== undefined ? { notice: githubAppNotice } : {})}
        />
      ),
    },
    {
      key: 'mattermost',
      label: 'Mattermost',
      tip: tMattermost('titleTip'),
      hint: t('mattermostHint'),
      status:
        mattermost?.config && mattermost.host ? (
          <Badge tone="success">{t('mattermostConnected', { host: mattermost.host })}</Badge>
        ) : (
          <Badge tone="outline">{t('notConnected')}</Badge>
        ),
      detail: (
        <MattermostManager
          canWrite={canWrite}
          secretNames={secretNames}
          {...(mattermost?.host !== undefined ? { serverHost: mattermost.host } : {})}
          {...(mattermost?.config !== undefined ? { config: mattermost.config } : {})}
        />
      ),
    },
    {
      key: 'image-registry',
      label: t('imageRegistryLabel'),
      tip: tRegistry.rich('titleTip', {
        mono: (chunks) => <span className="font-mono">{chunks}</span>,
      }),
      hint: t('imageRegistryHint'),
      status:
        imageRegistries.length > 0 ? (
          <Badge tone="success">{t('registeredCount', { count: imageRegistries.length })}</Badge>
        ) : (
          <Badge tone="outline">{t('notRegistered')}</Badge>
        ),
      detail: (
        <ImageRegistryManager
          registries={imageRegistries}
          canWrite={canWrite}
          secretNames={secretNames}
        />
      ),
    },
  ]

  return (
    <SettingsList>
      {rows.map((r) => {
        const open = active === r.key
        return (
          <li key={r.key}>
            <div className="flex min-h-[60px] flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="min-w-0 space-y-0.5">
                <span className="inline-flex flex-wrap items-center gap-2 text-[13px] font-[510] text-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    {r.label}
                    <InfoTip content={r.tip} />
                  </span>
                  {r.status}
                </span>
                <p className="text-[12px] leading-relaxed text-muted-foreground">{r.hint}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2 sm:justify-end">
                <Button
                  variant="secondary"
                  size="xs"
                  aria-expanded={open}
                  onClick={() => setActive(open ? undefined : r.key)}
                >
                  {open ? t('collapse') : t('manage')}
                  <ChevronDown className={cn('transition-transform', open && 'rotate-180')} />
                </Button>
              </div>
            </div>
            {open && <div className="border-t border-border/60 px-4 py-4">{r.detail}</div>}
          </li>
        )
      })}
    </SettingsList>
  )
}
