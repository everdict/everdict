'use client'

import { useState, useTransition } from 'react'
import { Stamp } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'

import { attestDatasetVersionAction } from '../api/attest-dataset'

// Approve a dataset version's ground-truth declarations. Admin-only at the control plane, and deliberately
// NOT a one-click button: a constitutional approval that costs one click is one nobody read.
export function AttestDatasetButton({
  id,
  version,
  canAttest,
}: {
  id: string
  version: string
  canAttest: boolean
}) {
  const t = useTranslations('datasetsPage')
  const refresh = useRefresh()
  const [busy, start] = useTransition()
  const [error, setError] = useState<string>()

  if (!canAttest) return null

  function attest() {
    setError(undefined)
    const note = window.prompt(t('attestPrompt'))
    // An empty note is a CANCEL. The approval is recorded with what was approved and why; an unexplained
    // one is the "authorization that leaves no artifact" the rule refuses.
    if (note === null || note.trim() === '') return
    start(async () => {
      const res = await attestDatasetVersionAction(id, version, note.trim())
      if (res.ok) refresh()
      else setError(res.error ?? t('attestError'))
    })
  }

  return (
    <span className="inline-flex items-center gap-2">
      {error !== undefined && <span className="text-[12px] text-destructive">{error}</span>}
      <Button variant="outline" size="sm" onClick={attest} disabled={busy} title={t('attestTitle')}>
        <Stamp className="size-4" /> {t('attest')}
      </Button>
    </span>
  )
}
