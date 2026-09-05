'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'

import { CreateIssueDialog, type CreateIssueDialogProps } from './create-issue-dialog'

// The button that files a new issue — the form itself is held by `CreateIssueDialog` and this only opens it.
export function CreateIssueButton({
  label,
  ...dialog
}: CreateIssueDialogProps & { label?: string }) {
  const t = useTranslations('issuesPage')
  const [open, setOpen] = useState(false)
  const sub = dialog.parentId !== undefined

  return (
    <>
      <Button
        size={sub ? 'xs' : 'sm'}
        variant={sub ? 'secondary' : 'primary'}
        onClick={() => setOpen(true)}
      >
        <Plus className="size-3.5" />
        {label ?? t('create')}
      </Button>
      <CreateIssueDialog {...dialog} open={open} onClose={() => setOpen(false)} />
    </>
  )
}
