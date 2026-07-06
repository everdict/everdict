'use client'

import { useParams, useRouter } from 'next/navigation'

import { Combobox } from '@/shared/ui/combobox'

// 하니스 상세의 버전 선택 — ?v= 로 이동(서버가 해당 버전을 조회). 버전이 아무리 많아도 드롭다운 하나로
// 축약한다(칩을 전부 나열하지 않음). 옵션이 많으면 Combobox 가 검색을 자동 활성(7개 초과). latest 를 위로.
// 페이지 헤더 우측에 놓이는 컴팩트 컨트롤 — 라벨 없이 aria-label 로만(값 자체가 vX.Y.Z 라 자명).
export function HarnessVersionSwitcher({
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
  if (versions.length === 0) return null
  return (
    <Combobox
      id="harness-version-switch"
      aria-label={`버전 (${versions.length})`}
      value={current}
      onChange={(v) =>
        router.push(`/${workspace}/harnesses/${encodeURIComponent(id)}?v=${encodeURIComponent(v)}`)
      }
      options={[...versions].reverse().map((v) => {
        const tags = versionTags?.[v]
        return {
          value: v,
          label: v === latest ? `${v} · latest` : v,
          ...(tags && tags.length > 0 ? { hint: tags.join(' · ') } : {}),
        }
      })}
      className="w-40"
    />
  )
}
