'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'

import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label } from '@/shared/ui/input'

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
  const { workspace } = useParams<{ workspace: string }>()
  const [d, setD] = useState(dataset ?? datasets[0]?.id ?? '')
  const [m, setM] = useState(metric ?? 'judge')
  const [b, setB] = useState(baseline ?? 'first')

  function go() {
    if (!d) return
    const q = new URLSearchParams({ dataset: d, metric: m || 'judge', baseline: b || 'first' })
    router.push(`/${workspace}/scorecards/trend?${q.toString()}`)
  }

  if (datasets.length === 0) return null

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-56 space-y-1.5">
        <Label htmlFor="dataset">Dataset</Label>
        <Combobox
          id="dataset"
          value={d}
          onChange={setD}
          options={datasets.map((o) => ({ value: o.id, label: o.label }))}
          className="w-full"
        />
      </div>
      <div className="min-w-36 space-y-1.5">
        <Label htmlFor="metric">Metric</Label>
        <Input id="metric" value={m} onChange={(e) => setM(e.target.value)} placeholder="judge" />
      </div>
      <div className="min-w-44 space-y-1.5">
        <Label htmlFor="baseline">Baseline</Label>
        <Combobox
          id="baseline"
          value={b}
          onChange={setB}
          options={[
            { value: 'first', label: 'first (첫 실행)' },
            { value: 'previous', label: 'previous (직전 실행)' },
          ]}
          className="w-full"
        />
      </div>
      <Button type="button" onClick={go} disabled={!d}>
        추이 보기
      </Button>
    </div>
  )
}
