'use client'

import { useState, useTransition } from 'react'
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { WorkspaceImageCatalog } from '@/entities/workspace-image'
import { fmtBytes, fmtDateTime } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Callout } from '@/shared/ui/callout'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import {
  listWorkspaceImageTagsAction,
  removeWorkspaceImageAction,
} from '../api/manage-workspace-images'

// Settings › Images — everdict가 직접 운영하는 워크스페이스 이미지 네임스페이스. BYO 레지스트리(Settings ›
// Integrations)와 나란히가 아니라 별도 화면인 이유는 소유 관계가 다르기 때문이다: 여기 있는 것은 우리가 저장하고
// grant를 발급하는 이미지고, BYO는 "당신이 알려준 레지스트리"다.
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
  const [expanded, setExpanded] = useState<string | null>(null)
  const [tags, setTags] = useState<Record<string, string[]>>({})
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // 관리형 스토어를 안 돌리는 배포 — 라우트가 404를 준다. 빈 목록으로 위장하지 않고 그렇게 말한다.
  if (unavailable || !catalog) {
    return <Callout tone="info">{t('notConfigured')}</Callout>
  }

  const toggle = (repository: string) => {
    if (expanded === repository) {
      setExpanded(null)
      return
    }
    setExpanded(repository)
    if (tags[repository]) return
    startTransition(async () => {
      const res = await listWorkspaceImageTagsAction(repository)
      if (res.ok) setTags((prev) => ({ ...prev, [repository]: res.tags }))
      else setError(res.error)
    })
  }

  const remove = (repository: string) => {
    setError(null)
    startTransition(async () => {
      const res = await removeWorkspaceImageAction(repository)
      if (!res.ok) setError(res.error)
    })
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
                <button
                  type="button"
                  onClick={() => toggle(repo.name)}
                  className="flex items-center gap-1.5 text-left font-medium hover:underline"
                >
                  {expanded === repo.name ? (
                    <ChevronDown className="size-3.5 shrink-0" />
                  ) : (
                    <ChevronRight className="size-3.5 shrink-0" />
                  )}
                  {repo.name}
                </button>
              }
              hint={
                <span className="space-y-1">
                  <code className="text-xs">{repo.image}</code>
                  {repo.updatedAt && (
                    <span className="ml-2 text-xs">{fmtDateTime(repo.updatedAt)}</span>
                  )}
                  {expanded === repo.name && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {(tags[repo.name] ?? repo.tags ?? []).map((tag) => (
                        <Badge key={tag} tone="outline">
                          {tag}
                        </Badge>
                      ))}
                      {(tags[repo.name] ?? repo.tags ?? []).length === 0 && (
                        <span className="text-xs text-muted-foreground">
                          {pending ? t('loadingTags') : t('noTags')}
                        </span>
                      )}
                    </span>
                  )}
                </span>
              }
            >
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
