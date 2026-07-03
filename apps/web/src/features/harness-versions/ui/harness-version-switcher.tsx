'use client'

import { useParams, useRouter } from 'next/navigation'

import { Combobox } from '@/shared/ui/combobox'
import { Label } from '@/shared/ui/input'

// 하니스 상세의 버전 선택 — ?v= 로 이동(서버가 해당 버전을 조회). 버전이 아무리 많아도 드롭다운 하나로
// 축약한다(칩을 전부 나열하지 않음). 옵션이 많으면 Combobox 가 검색을 자동 활성(7개 초과). latest 를 위로.
export function HarnessVersionSwitcher({
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
    <div className="min-w-40 space-y-1.5">
      <Label htmlFor="harness-version-switch">버전 ({versions.length})</Label>
      <Combobox
        id="harness-version-switch"
        value={current}
        onChange={(v) =>
          router.push(
            `/${workspace}/harnesses/${encodeURIComponent(id)}?v=${encodeURIComponent(v)}`
          )
        }
        options={[...versions].reverse().map((v) => ({
          value: v,
          label: v === latest ? `${v} · latest` : v,
        }))}
        className="w-full"
      />
    </div>
  )
}
