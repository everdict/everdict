'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/shared/ui/button'
import { Label, Select } from '@/shared/ui/input'

export interface CompareOption {
  id: string
  label: string
}

// baseline/candidate 스코어카드를 골라 비교 URL 로 이동. 실제 diff 는 서버가 계산.
export function ComparePicker({
  options,
  baseline,
  candidate,
}: {
  options: CompareOption[]
  baseline?: string
  candidate?: string
}) {
  const router = useRouter()
  const [b, setB] = useState(baseline ?? options[0]?.id ?? '')
  const [c, setC] = useState(candidate ?? options[1]?.id ?? options[0]?.id ?? '')

  function compare() {
    if (b && c) {
      router.push(`/dashboard/scorecards/compare?baseline=${encodeURIComponent(b)}&candidate=${encodeURIComponent(c)}`)
    }
  }

  if (options.length === 0) return null

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-56 space-y-1.5">
        <Label htmlFor="baseline">Baseline</Label>
        <Select id="baseline" value={b} onChange={(e) => setB(e.target.value)}>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="min-w-56 space-y-1.5">
        <Label htmlFor="candidate">Candidate</Label>
        <Select id="candidate" value={c} onChange={(e) => setC(e.target.value)}>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
      <Button type="button" onClick={compare} disabled={!b || !c}>
        비교
      </Button>
    </div>
  )
}
