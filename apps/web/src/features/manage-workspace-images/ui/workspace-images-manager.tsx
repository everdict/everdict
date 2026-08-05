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

// Settings › Images — everdict가 직접 운영하는 워크스페이스 이미지 네임스페이스. BYO 레지스트리(Settings ›
// Integrations)와 나란히가 아니라 별도 화면인 이유는 소유 관계가 다르기 때문이다: 여기 있는 것은 우리가 저장하고
// grant를 발급하는 이미지고, BYO는 "당신이 알려준 레지스트리"다.
// 목록은 레지스트리 UI 의 문법을 따른다: 행 이름이 곧 드릴인이고, 버전(태그)·빌드 히스토리·환경 컨텍스트는 상세가 답한다.
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

  // 관리형 스토어를 안 돌리는 배포 — 라우트가 404를 준다. 빈 목록으로 위장하지 않고 그렇게 말한다.
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
