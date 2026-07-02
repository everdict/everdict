'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'

import { Button } from '@/shared/ui/button'
import { Input, Label, Select } from '@/shared/ui/input'

export interface DatasetOption {
  id: string
  label: string
}

// dataset/metric/window 를 골라 리더보드 URL 로 이동. 실제 랭킹은 서버가 계산.
export function LeaderboardPicker({
  datasets,
  dataset,
  metric,
  window,
}: {
  datasets: DatasetOption[]
  dataset?: string
  metric?: string
  window?: string
}) {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const [d, setD] = useState(dataset ?? datasets[0]?.id ?? '')
  const [m, setM] = useState(metric ?? 'judge')
  const [w, setW] = useState(window === 'best' ? 'best' : 'latest')

  function go() {
    if (!d) return
    const q = new URLSearchParams({ dataset: d, metric: m || 'judge', window: w })
    router.push(`/${workspace}/scorecards/leaderboard?${q.toString()}`)
  }

  if (datasets.length === 0) return null

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-56 space-y-1.5">
        <Label htmlFor="dataset">Dataset (벤치마크)</Label>
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
        <Label htmlFor="window">집계</Label>
        <Select id="window" value={w} onChange={(e) => setW(e.target.value)}>
          <option value="latest">latest (최신 실행)</option>
          <option value="best">best (최고 점수)</option>
        </Select>
      </div>
      <Button type="button" onClick={go} disabled={!d}>
        리더보드 보기
      </Button>
    </div>
  )
}
