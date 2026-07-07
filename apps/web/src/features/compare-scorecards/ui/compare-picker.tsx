'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Label } from '@/shared/ui/input'

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
  const { workspace } = useParams<{ workspace: string }>()
  const t = useTranslations('compareScorecards')
  const [b, setB] = useState(baseline ?? options[0]?.id ?? '')
  const [c, setC] = useState(candidate ?? options[1]?.id ?? options[0]?.id ?? '')

  function compare() {
    if (b && c) {
      router.push(
        `/${workspace}/scorecards/compare?baseline=${encodeURIComponent(b)}&candidate=${encodeURIComponent(c)}`
      )
    }
  }

  if (options.length === 0) return null

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-56 space-y-1.5">
        <Label htmlFor="baseline">{t('baselineLabel')}</Label>
        <Combobox
          id="baseline"
          value={b}
          onChange={setB}
          options={options.map((o) => ({ value: o.id, label: o.label }))}
          className="w-full"
        />
      </div>
      <div className="min-w-56 space-y-1.5">
        <Label htmlFor="candidate">{t('candidateLabel')}</Label>
        <Combobox
          id="candidate"
          value={c}
          onChange={setC}
          options={options.map((o) => ({ value: o.id, label: o.label }))}
          className="w-full"
        />
      </div>
      <Button type="button" onClick={compare} disabled={!b || !c}>
        {t('submit')}
      </Button>
    </div>
  )
}
