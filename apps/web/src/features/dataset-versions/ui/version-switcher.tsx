'use client'

import { useParams, useRouter } from 'next/navigation'

import { Label, Select } from '@/shared/ui/input'

// 상세 페이지에서 어느 버전의 케이스를 볼지 고른다 — ?version= 으로 이동(서버가 해당 버전을 조회).
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
    <div className="min-w-44 space-y-1.5">
      <Label htmlFor="version-switch">버전</Label>
      <Select
        id="version-switch"
        value={current}
        onChange={(e) =>
          router.push(
            `/${workspace}/datasets/${encodeURIComponent(id)}?version=${encodeURIComponent(e.target.value)}`
          )
        }
      >
        {versions.map((v) => (
          <option key={v} value={v}>
            {v}
            {v === latest ? ' (latest)' : ''}
          </option>
        ))}
      </Select>
    </div>
  )
}
