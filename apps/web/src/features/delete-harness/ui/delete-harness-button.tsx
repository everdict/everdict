'use client'

import { useState } from 'react'
import { Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'

import { DeleteHarnessDialog } from './delete-harness-dialog'

// Detail-header entry point — a subtle destructive button that opens the delete dialog (versions to remove are chosen there).
// Gate visibility at the call site (admin + workspace-owned); the control plane is still the final enforcer.
export function DeleteHarnessButton({
  id,
  versions,
  latest,
  workspace,
  versionTags,
}: {
  id: string
  versions: string[]
  latest: string
  workspace: string
  versionTags?: Record<string, string[]>
}) {
  const t = useTranslations('deleteHarness')
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
        <DeleteHarnessDialog
          onClose={() => setOpen(false)}
          id={id}
          versions={versions}
          latest={latest}
          workspace={workspace}
          {...(versionTags ? { versionTags } : {})}
        />
      )}
    </>
  )
}
