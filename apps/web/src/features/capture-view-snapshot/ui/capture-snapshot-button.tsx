'use client'

import { useState, useTransition } from 'react'
import { Camera } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { Button } from '@/shared/ui/button'

import { captureViewSnapshot } from '../api/capture-view-snapshot'

// Capture now. The control plane computes and writes the file; this only reports where it landed, because the
// numbers must come from the same engine a scheduled capture uses.
export function CaptureSnapshotButton({
  workspace,
  viewId,
}: {
  workspace: string
  viewId: string
}) {
  const t = useTranslations('viewSnapshots')
  const [pending, start] = useTransition()
  const [busy, setBusy] = useState(false)

  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={pending || busy}
      onClick={() => {
        setBusy(true)
        start(async () => {
          const res = await captureViewSnapshot(workspace, viewId)
          setBusy(false)
          if (res.ok) toast.success(t('captured', { cases: res.result.totals.cases }))
          else toast.error(t('captureFailed', { error: res.error }))
        })
      }}
    >
      <Camera className="size-4" />
      {pending || busy ? t('capturing') : t('capture')}
    </Button>
  )
}
