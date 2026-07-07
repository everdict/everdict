'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { Combobox } from '@/shared/ui/combobox'
import { Label } from '@/shared/ui/input'

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
  const t = useTranslations('byHarnessScorecards')
  const [h, setH] = useState(harness ?? harnesses[0]?.id ?? '')

  function go(next: string) {
    setH(next)
    if (next) router.push(`/${workspace}/scorecards/by-harness?harness=${encodeURIComponent(next)}`)
  }

  if (harnesses.length === 0) return null

  return (
    <div className="min-w-56 space-y-1.5">
      <Label htmlFor="harness">{t('harnessLabel')}</Label>
      <Combobox
        id="harness"
        value={h}
        onChange={go}
        options={harnesses.map((o) => ({ value: o.id, label: o.label }))}
        className="w-full"
      />
    </div>
  )
}
