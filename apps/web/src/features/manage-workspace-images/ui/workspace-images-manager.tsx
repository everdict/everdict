'use client'

import { useState } from 'react'
import { useParams } from 'next/navigation'
import { Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { WorkspaceImageCatalog } from '@/entities/workspace-image'
import { fmtBytes, fmtDateTime } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { Link } from '@/shared/ui/link'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import { removeWorkspaceImageAction } from '../api/manage-workspace-images'

// Settings › Images — the workspace image namespace everdict operates itself. It is a separate screen rather than sitting beside the BYO
// registries (Settings › Integrations) because the OWNERSHIP differs: what is here are images we store and issue grants for,
// while a BYO is "the registry you told us about".
// The list follows a registry UI's grammar: a row's name IS the drill-in, and versions (tags), build history and environment context are answered by the detail.
export function WorkspaceImagesManager({
  catalog,
  canPush,
  unavailable,
}: {
  catalog: WorkspaceImageCatalog | null
  canPush: boolean
  unavailable: boolean
}) {
  const t = useTranslations('workspaceImages')
  const workspace = String(useParams().workspace ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  // A deployment not running a managed store — the route answers 404. It SAYS so rather than disguising it as an empty list.
  if (unavailable || !catalog) {
    return <Callout tone="info">{t('notConfigured')}</Callout>
  }

  const remove = (repository: string) => {
    setError(null)
    void (async () => {
      setPending(true)
      try {
        const res = await removeWorkspaceImageAction(repository)
        if (!res.ok) setError(res.error)
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Badge tone="outline">{t('repositoryCount', { count: catalog.usage.repositories })}</Badge>
        {catalog.usage.bytes !== undefined && (
          <Badge tone="outline">{fmtBytes(catalog.usage.bytes)}</Badge>
        )}
        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
          {catalog.endpoint}/{catalog.namespace}/
        </code>
        <InfoTip content={t('prefixTip')} />
      </div>

      {error && <Callout tone="danger">{error}</Callout>}

      {catalog.repositories.length === 0 ? (
        <Callout tone="info">{t('empty')}</Callout>
      ) : (
        <SettingsList>
          {catalog.repositories.map((repo) => (
            <SettingsRow
              key={repo.repository}
              label={
                <Link
                  href={`/${workspace}/settings/images/${encodeURIComponent(repo.name)}`}
                  className="font-medium hover:underline"
                >
                  {repo.name}
                </Link>
              }
              hint={
                <span className="space-y-1">
                  <code className="text-xs">{repo.image}</code>
                  {repo.updatedAt && (
                    <span className="ml-2 text-xs">{fmtDateTime(repo.updatedAt)}</span>
                  )}
                </span>
              }
            >
              {repo.tags !== undefined && (
                <span className="text-xs text-muted-foreground">
                  {t('versionCount', { count: repo.tags.length })}
                </span>
              )}
              {repo.sizeBytes !== undefined && (
                <span className="text-xs text-muted-foreground">{fmtBytes(repo.sizeBytes)}</span>
              )}
              {canPush && (
                <button
                  type="button"
                  onClick={() => remove(repo.name)}
                  disabled={pending}
                  aria-label={t('removeAria', { name: repo.name })}
                  className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </SettingsRow>
          ))}
        </SettingsList>
      )}
    </div>
  )
}
