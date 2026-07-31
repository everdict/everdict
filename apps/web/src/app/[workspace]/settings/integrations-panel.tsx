'use client'

import { useState, type ComponentType, type ReactNode } from 'react'
import { Boxes, Github, MessagesSquare, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { GithubAppManager, type GithubAppNotice } from '@/features/manage-github-app'
import { ImageRegistryManager } from '@/features/manage-image-registry'
import { MattermostManager } from '@/features/manage-mattermost'
import type { GithubAppView } from '@/entities/github-app'
import type { ImageRegistryConfig } from '@/entities/image-registry'
import type { MattermostConfig } from '@/entities/mattermost'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { InfoTip } from '@/shared/ui/tooltip'

export type IntegrationKey = 'github' | 'mattermost' | 'image-registry'

interface IntegrationTile {
  key: IntegrationKey
  label: string
  icon: ComponentType<{ className?: string }>
  tint: string // the icon chip's own accent, so a tile is recognizable before its label is read
  tip: ReactNode
  hint: string
  count: number // 0 = not connected
  status: string
  detail: ReactNode
}

// Integrations tab — an ICON TILE GRID (the roster keeps growing, so a tile is scannable at a glance: brand-tinted
// glyph + name + connection count) with the selected integration's manager expanded IN PLACE below the grid. Not a
// drill-in route and not a stack of full-width rows: the other integrations stay visible while one is being managed.
// If a GitHub App installation callback just fired (githubAppNotice) or a ?app= deep link is present, that tile starts
// open.
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
  // Mattermost status: host = operator env server URL (absent = unavailable — the URL itself is never surfaced);
  // connections = the workspace's registered bot+channel pairs.
  mattermost?: { host?: string; connections?: MattermostConfig[] }
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
  const mattermostConnections = mattermost?.connections ?? []

  const tiles: IntegrationTile[] = [
    {
      key: 'github',
      label: 'GitHub',
      icon: Github,
      tint: 'bg-foreground/[0.06] text-foreground',
      tip: tGithub('titleTip'),
      hint: t('githubHint'),
      count: githubApp.installations.length,
      status:
        githubApp.installations.length > 0
          ? t('githubCount', { count: githubApp.installations.length })
          : t('notConnected'),
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
      icon: MessagesSquare,
      tint: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
      tip: tMattermost('titleTip'),
      hint: t('mattermostHint'),
      // A connection needs the operator's server to be usable at all — without it nothing is really connected.
      count: mattermost?.host ? mattermostConnections.length : 0,
      status:
        mattermost?.host && mattermostConnections.length > 0
          ? t('mattermostCount', { count: mattermostConnections.length })
          : t('notConnected'),
      detail: (
        <MattermostManager
          canWrite={canWrite}
          secretNames={secretNames}
          connections={mattermostConnections}
          {...(mattermost?.host !== undefined ? { serverHost: mattermost.host } : {})}
        />
      ),
    },
    {
      key: 'image-registry',
      label: t('imageRegistryLabel'),
      icon: Boxes,
      tint: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
      tip: tRegistry.rich('titleTip', {
        mono: (chunks) => <span className="font-mono">{chunks}</span>,
      }),
      hint: t('imageRegistryHint'),
      count: imageRegistries.length,
      status:
        imageRegistries.length > 0
          ? t('imageRegistryCount', { count: imageRegistries.length })
          : t('notRegistered'),
      detail: (
        <ImageRegistryManager
          registries={imageRegistries}
          canWrite={canWrite}
          secretNames={secretNames}
        />
      ),
    },
  ]

  const open = tiles.find((tile) => tile.key === active)

  return (
    <div className="@container space-y-4">
      <ul className="grid grid-cols-2 gap-2 @md:grid-cols-3 @2xl:grid-cols-4">
        {tiles.map((tile) => {
          const selected = tile.key === active
          const Icon = tile.icon
          return (
            <li key={tile.key}>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => setActive(selected ? undefined : tile.key)}
                className={cn(
                  'flex h-full w-full flex-col items-start gap-2 rounded-lg border bg-card p-3 text-left transition',
                  'hover:border-border/90 hover:shadow-raise',
                  selected && 'border-primary/60 ring-1 ring-primary/25'
                )}
              >
                <span
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-md',
                    tile.tint
                  )}
                >
                  <Icon className="size-[18px]" />
                </span>
                <span className="min-w-0 space-y-0.5">
                  <span className="block truncate text-[13px] font-[510] text-foreground">
                    {tile.label}
                  </span>
                  <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                    <span
                      className={cn(
                        'size-1.5 shrink-0 rounded-full',
                        tile.count > 0 ? 'bg-success' : 'bg-border'
                      )}
                    />
                    <span className="truncate">{tile.status}</span>
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      {open && (
        <section className="rounded-lg border bg-card">
          <header className="flex items-start justify-between gap-4 px-4 py-3">
            <div className="min-w-0 space-y-0.5">
              <span className="inline-flex items-center gap-1.5 text-[13px] font-[560] text-foreground">
                {open.label}
                <InfoTip content={open.tip} />
              </span>
              <p className="text-[12px] leading-relaxed text-muted-foreground">{open.hint}</p>
            </div>
            <Button
              variant="ghost"
              size="xs"
              aria-label={t('collapse')}
              onClick={() => setActive(undefined)}
            >
              <X />
            </Button>
          </header>
          <div className="border-t border-border/60 px-4 py-4">{open.detail}</div>
        </section>
      )}
    </div>
  )
}
