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

// dataset/metric/window/judgeModel 을 골라 리더보드 URL 로 이동. 실제 랭킹은 서버가 계산.
export function LeaderboardPicker({
  datasets,
  dataset,
  metric,
  window,
  judgeModel,
}: {
  datasets: DatasetOption[]
  dataset?: string
  metric?: string
  window?: string
  judgeModel?: string
}) {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const [d, setD] = useState(dataset ?? datasets[0]?.id ?? '')
  const [m, setM] = useState(metric ?? 'judge')
  const [w, setW] = useState(window === 'best' ? 'best' : 'latest')
  const [jm, setJm] = useState(judgeModel ?? '')

  function go() {
    if (!d) return
    const q = new URLSearchParams({ dataset: d, metric: m || 'judge', window: w })
    if (jm) q.set('judgeModel', jm)
    router.push(`/${workspace}/scorecards/leaderboard?${q.toString()}`)
  }

  if (datasets.length === 0) return null

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-56 space-y-1.5">
        <Label htmlFor="dataset">Dataset (벤치마크)</Label>
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
        <Label htmlFor="window">집계</Label>
        <Combobox
          id="window"
          value={w}
          onChange={setW}
          options={[
            { value: 'latest', label: 'latest (최신 실행)' },
            { value: 'best', label: 'best (최고 점수)' },
          ]}
          className="w-full"
        />
      </div>
      <div className="min-w-40 space-y-1.5">
        <Label htmlFor="judgeModel">Judge 모델 (선택)</Label>
        <Input
          id="judgeModel"
          value={jm}
          onChange={(e) => setJm(e.target.value)}
          placeholder="같은 채점자만"
        />
      </div>
      <Button type="button" onClick={go} disabled={!d}>
        리더보드 보기
      </Button>
    </div>
  )
}
