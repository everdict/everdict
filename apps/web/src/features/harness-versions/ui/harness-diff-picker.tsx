'use client'

import { useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Label } from '@/shared/ui/input'

// Pick base/candidate versions to navigate to the harness diff URL. The diff is computed by the control plane (diffHarnessSpecs).
// `versions` is passed newest-first (registration order reversed) — harness versions are not necessarily semver, so no re-sort here.
export function HarnessDiffPicker({
  id,
  versions,
  base,
  candidate,
  latest,
  versionTags,
}: {
  id: string
  versions: string[]
  base?: string
  candidate?: string
  latest?: string
  versionTags?: Record<string, string[]> // per-version free-form labels — shown as a hint to tell versions apart
}) {
  const router = useRouter()
  const { workspace } = useParams<{ workspace: string }>()
  const t = useTranslations('harnessVersions')
  // Defaults: candidate=latest, base=previous (versions are passed newest-first).
  const [b, setB] = useState(base ?? versions[1] ?? versions[0] ?? '')
  const [c, setC] = useState(candidate ?? versions[0] ?? '')

  if (versions.length < 2) return null

  function compare() {
    if (b && c)
      router.push(
        `/${workspace}/harnesses/${encodeURIComponent(id)}/diff?base=${encodeURIComponent(b)}&candidate=${encodeURIComponent(c)}`
      )
  }

  const options = versions.map((v) => {
    const tags = versionTags?.[v]
    return {
      value: v,
      label: v === latest ? `${v} · latest` : v,
      ...(tags && tags.length > 0 ? { hint: tags.join(' · ') } : {}),
    }
  })

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-44 space-y-1.5">
        <Label htmlFor="harness-diff-base">base</Label>
        <Combobox id="harness-diff-base" value={b} onChange={setB} options={options} className="w-full" />
      </div>
      <div className="min-w-44 space-y-1.5">
        <Label htmlFor="harness-diff-candidate">candidate</Label>
        <Combobox
          id="harness-diff-candidate"
          value={c}
          onChange={setC}
          options={options}
          className="w-full"
        />
      </div>
      <Button type="button" onClick={compare} disabled={!b || !c || b === c}>
        {t('compare')}
      </Button>
    </div>
  )
}
