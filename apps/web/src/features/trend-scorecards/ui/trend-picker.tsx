'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/shared/ui/button'
import { Input, Label, Select } from '@/shared/ui/input'

export interface DatasetOption {
  id: string
  label: string
}

// dataset/metric/baseline 을 골라 트렌드 URL 로 이동. 실제 시계열은 서버가 계산.
export function TrendPicker({
  datasets,
  dataset,
  metric,
  baseline,
}: {
  datasets: DatasetOption[]
  dataset?: string
  metric?: string
  baseline?: string
}) {
  const router = useRouter()
  const [d, setD] = useState(dataset ?? datasets[0]?.id ?? '')
  const [m, setM] = useState(metric ?? 'judge')
  const [b, setB] = useState(baseline ?? 'first')

  function go() {
    if (!d) return
    const q = new URLSearchParams({ dataset: d, metric: m || 'judge', baseline: b || 'first' })
    router.push(`/dashboard/scorecards/trend?${q.toString()}`)
  }

  if (datasets.length === 0) return null

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-56 space-y-1.5">
        <Label htmlFor="dataset">Dataset</Label>
        <Select id="dataset" value={d} onChange={(e) => setD(e.target.value)}>
          {datasets.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="min-w-36 space-y-1.5">
        <Label htmlFor="metric">Metric</Label>
        <Input id="metric" value={m} onChange={(e) => setM(e.target.value)} placeholder="judge" />
      </div>
      <div className="min-w-44 space-y-1.5">
        <Label htmlFor="baseline">Baseline</Label>
        <Select id="baseline" value={b} onChange={(e) => setB(e.target.value)}>
          <option value="first">first (첫 실행)</option>
          <option value="previous">previous (직전 실행)</option>
        </Select>
      </div>
      <Button type="button" onClick={go} disabled={!d}>
        추이 보기
      </Button>
    </div>
  )
}
