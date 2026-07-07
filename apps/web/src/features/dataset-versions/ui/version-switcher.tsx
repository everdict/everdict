'use client'

import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { Combobox } from '@/shared/ui/combobox'

// 상세 페이지에서 어느 버전의 케이스를 볼지 고른다 — ?version= 으로 이동(서버가 해당 버전을 조회).
// 페이지 헤더 우측에 놓이는 컴팩트 컨트롤 — 라벨 없이 aria-label 로만(값 자체가 vX.Y.Z 라 자명).
export function VersionSwitcher({
  id,
  versions,
  current,
  latest,
  versionTags,
}: {
  id: string
  versions: string[]
  current: string
  latest?: string
  versionTags?: Record<string, string[]> // 버전 태그(자유 라벨) — 옵션 우측 hint 로 붙여 번호를 분간
}) {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const t = useTranslations('datasetVersions')
  if (versions.length === 0) return null
  return (
    <Combobox
      id="version-switch"
      aria-label={t('versionAria')}
      value={current}
      onChange={(v) =>
        router.push(
          `/${workspace}/datasets/${encodeURIComponent(id)}?version=${encodeURIComponent(v)}`
        )
      }
      options={versions.map((v) => {
        const tags = versionTags?.[v]
        return {
          value: v,
          label: v === latest ? `${v} (latest)` : v,
          ...(tags && tags.length > 0 ? { hint: tags.join(' · ') } : {}),
        }
      })}
      className="w-44"
    />
  )
}
