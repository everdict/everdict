'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Label } from '@/shared/ui/input'

// base/candidate 버전을 골라 diff URL 로 이동. 실제 diff 는 서버(컨트롤플레인 diffDatasets)가 계산.
export function DiffPicker({
  id,
  versions,
  base,
  candidate,
}: {
  id: string
  versions: string[]
  base?: string
  candidate?: string
}) {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const t = useTranslations('datasetVersions')
  // 기본값: candidate=최신, base=직전(versions 는 최신순 정렬되어 전달됨).
  const [b, setB] = useState(base ?? versions[1] ?? versions[0] ?? '')
  const [c, setC] = useState(candidate ?? versions[0] ?? '')

  if (versions.length < 2) return null

  function compare() {
    if (b && c)
      router.push(
        `/${workspace}/datasets/${encodeURIComponent(id)}/diff?base=${encodeURIComponent(b)}&candidate=${encodeURIComponent(c)}`
      )
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-44 space-y-1.5">
        <Label htmlFor="diff-base">base</Label>
        <Combobox
          id="diff-base"
          value={b}
          onChange={setB}
          options={versions.map((v) => ({ value: v }))}
          className="w-full"
        />
      </div>
      <div className="min-w-44 space-y-1.5">
        <Label htmlFor="diff-candidate">candidate</Label>
        <Combobox
          id="diff-candidate"
          value={c}
          onChange={setC}
          options={versions.map((v) => ({ value: v }))}
          className="w-full"
        />
      </div>
      <Button type="button" onClick={compare} disabled={!b || !c || b === c}>
        {t('compare')}
      </Button>
    </div>
  )
}
