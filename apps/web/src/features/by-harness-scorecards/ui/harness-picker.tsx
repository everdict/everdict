'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'

import { Label, Select } from '@/shared/ui/input'

export interface HarnessOption {
  id: string
  label: string
}

// harness 를 골라 harness-중심 뷰로 이동(그 harness 가 수행한 모든 벤치마크 스코어 + 버전별 모델).
export function HarnessPicker({
  harnesses,
  harness,
}: {
  harnesses: HarnessOption[]
  harness?: string
}) {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const [h, setH] = useState(harness ?? harnesses[0]?.id ?? '')

  function go(next: string) {
    setH(next)
    if (next) router.push(`/${workspace}/scorecards/by-harness?harness=${encodeURIComponent(next)}`)
  }

  if (harnesses.length === 0) return null

  return (
    <div className="min-w-56 space-y-1.5">
      <Label htmlFor="harness">Harness</Label>
      <Select id="harness" value={h} onChange={(e) => go(e.target.value)}>
        {harnesses.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </Select>
    </div>
  )
}
