'use client'

import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'

import { DeleteScorecardDialog } from './delete-scorecard-dialog'

// Detail-header entry point — a subtle destructive button that opens the confirm dialog (same grammar as the
// harness/dataset/judge detail deletes). Gate visibility at the call site (terminal batch + creator-or-admin);
// the control plane is the final enforcer.
export function DeleteScorecardButton({
  id,
  dataset,
  harness,
  workspace,
}: {
  id: string
  dataset: { id: string; version: string }
  harness: { id: string; version: string }
  workspace: string
}) {
  const t = useTranslations('deleteScorecard')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2 className="size-3.5" />
        {t('triggerButton')}
      </Button>
      {open && (
        <DeleteScorecardDialog
          onClose={() => setOpen(false)}
          id={id}
          dataset={dataset}
          harness={harness}
          workspace={workspace}
          afterDelete="toList"
        />
      )}
    </>
  )
}
