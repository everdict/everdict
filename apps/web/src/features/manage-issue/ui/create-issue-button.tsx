'use client'

import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'

import { CreateIssueDialog, type CreateIssueDialogProps } from './create-issue-dialog'

// 새 이슈를 접수하는 버튼 — 폼 자체는 `CreateIssueDialog` 가 들고 있고 여기서는 여는 일만 한다.
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
