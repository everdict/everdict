'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label } from '@/shared/ui/input'

import { deleteWorkspaceAction } from '../api/delete-workspace'

// Danger zone — rendered only to the owner (isOwner-gated upstream). The card exposes only a delete button; clicking it opens a popup where
// you must type the workspace name exactly to enable deletion (mistake prevention). On success, redirect to home (/) to re-route to a remaining workspace/onboarding.
export function DeleteWorkspaceCard({ workspaceName }: { workspaceName: string }) {
  const t = useTranslations('deleteWorkspace')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, startTransition] = useTransition()
  const match = confirm.trim() === workspaceName

  function close() {
    if (pending) return
    setOpen(false)
    setConfirm('')
    setError(undefined)
  }

  function onDelete() {
    if (!match) return
    setError(undefined)
    startTransition(async () => {
      const r = await deleteWorkspaceAction()
      if (r.ok) {
        router.push('/')
        router.refresh()
      } else {
        setError(r.error ?? t('deleteFailed'))
      }
    })
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-destructive/30 bg-destructive/[0.03] p-4">
      <div className="space-y-1">
        <h3 className="text-[13px] font-[560] text-foreground">{t('title')}</h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{t('cardDescription')}</p>
      </div>
      <Button variant="destructive" onClick={() => setOpen(true)} className="shrink-0 gap-1.5">
        <Trash2 className="size-4" />
        {t('title')}
      </Button>

      <Dialog open={open} onClose={close} className="max-w-md" labelledBy="ws-delete-title">
        <div className="space-y-4 p-5">
          <div className="space-y-1.5">
            <h2 id="ws-delete-title" className="text-[15px] font-[560] text-foreground">
              {t('title')}
            </h2>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {t.rich('dialogWarning', {
                name: workspaceName,
                b: (chunks) => <span className="font-[510] text-foreground">{chunks}</span>,
              })}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-delete-confirm">
              {t.rich('confirmPrompt', {
                name: workspaceName,
                code: (chunks) => <span className="font-mono text-foreground">{chunks}</span>,
              })}
            </Label>
            <Input
              id="ws-delete-confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={workspaceName}
              autoComplete="off"
            />
          </div>
          {error && <Callout tone="danger">{error}</Callout>}
          <div className="flex items-center justify-end gap-2.5 pt-1">
            <Button variant="secondary" onClick={close} disabled={pending}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={onDelete}
              disabled={!match || pending}
              className="gap-1.5"
            >
              <Trash2 className="size-4" />
              {pending ? t('deleting') : t('permanentDelete')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
