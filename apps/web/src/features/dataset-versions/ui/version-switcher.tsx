'use client'

import { useParams, useRouter } from 'next/navigation'

import { Combobox } from '@/shared/ui/combobox'

// 상세 페이지에서 어느 버전의 케이스를 볼지 고른다 — ?version= 으로 이동(서버가 해당 버전을 조회).
// 페이지 헤더 우측에 놓이는 컴팩트 컨트롤 — 라벨 없이 aria-label 로만(값 자체가 vX.Y.Z 라 자명).
export function VersionSwitcher({
  id,
  versions,
  current,
  latest,
}: {
  id: string
  versions: string[]
  current: string
  latest?: string
}) {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  if (versions.length === 0) return null
  return (
    <Combobox
      id="version-switch"
      aria-label="버전"
      value={current}
      onChange={(v) =>
        router.push(
          `/${workspace}/datasets/${encodeURIComponent(id)}?version=${encodeURIComponent(v)}`
        )
      }
      options={versions.map((v) => ({
        value: v,
        label: v === latest ? `${v} (latest)` : v,
      }))}
      className="w-44"
    />
  )
}
