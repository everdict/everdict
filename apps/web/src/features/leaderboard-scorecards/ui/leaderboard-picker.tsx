'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Input, Label } from '@/shared/ui/input'

export interface DatasetOption {
  id: string
  label: string
}

// Pick dataset/metric/window/judgeModel to navigate to the leaderboard URL. The actual ranking is computed by the server.
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
  const t = useTranslations('leaderboardScorecards')
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
        <Label htmlFor="dataset">{t('datasetLabel')}</Label>
        <Combobox
          id="dataset"
          value={d}
          onChange={setD}
          options={datasets.map((o) => ({ value: o.id, label: o.label }))}
          className="w-full"
        />
      </div>
      <div className="min-w-36 space-y-1.5">
        <Label htmlFor="metric">{t('metricLabel')}</Label>
        <Input id="metric" value={m} onChange={(e) => setM(e.target.value)} placeholder="judge" />
      </div>
      <div className="min-w-44 space-y-1.5">
        <Label htmlFor="window">{t('windowLabel')}</Label>
        <Combobox
          id="window"
          value={w}
          onChange={setW}
          options={[
            { value: 'latest', label: t('windowLatest') },
            { value: 'best', label: t('windowBest') },
          ]}
          className="w-full"
        />
      </div>
      <div className="min-w-40 space-y-1.5">
        <Label htmlFor="judgeModel">{t('judgeModelLabel')}</Label>
        <Input
          id="judgeModel"
          value={jm}
          onChange={(e) => setJm(e.target.value)}
          placeholder={t('judgeModelPlaceholder')}
        />
      </div>
      <Button type="button" onClick={go} disabled={!d}>
        {t('submit')}
      </Button>
    </div>
  )
}
