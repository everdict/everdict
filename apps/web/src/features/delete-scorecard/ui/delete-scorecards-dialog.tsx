'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, TriangleAlert, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EntityRef } from '@/shared/ui/chip'
import { Dialog } from '@/shared/ui/dialog'

import { deleteScorecardsAction } from '../api/delete-scorecards'

type Target = {
  id: string
  dataset: { id: string; version: string }
  harness: { id: string; version: string }
}

// Bulk-delete confirm dialog — the multi-select already happened on the list, so this just confirms the set and fans
// out over it (HARD delete: each batch's case results + child runs). A partial failure (permission / still-running batch)
// keeps the dialog open with only the failed batches left for retry, mirroring the harness version fan-out.
// Mount only when open (the parent gates with `{open && …}`) so state initializes fresh each time.
export function DeleteScorecardsDialog({
  onClose,
  targets,
  onDeleted,
}: {
  onClose: () => void
  targets: Target[]
  // Report the ids that were actually removed so the list can drop them from its selection.
  onDeleted: (ids: string[]) => void
}) {
  const t = useTranslations('deleteScorecard')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  // Shrinks as batches are deleted, so a partial failure leaves only the still-present ones actionable for retry.
  const [remaining, setRemaining] = useState<Target[]>(targets)
  const [failed, setFailed] = useState<{ id: string; error: string }[]>([])
  const titleId = 'delete-scorecards'

  function onConfirm() {
    if (pending || remaining.length === 0) return
    startTransition(async () => {
      const res = await deleteScorecardsAction({ ids: remaining.map((r) => r.id) })
      if (res.deleted.length > 0) {
        toast.success(t('deletedMany', { count: res.deleted.length }))
        onDeleted(res.deleted)
        router.refresh()
      }
      if (res.failed.length === 0) {
        onClose()
        return
      }
      // Keep the dialog open on partial failure — drop the deleted rows, keep the failed ones, show why.
      const failedIds = new Set(res.failed.map((f) => f.id))
      setRemaining(remaining.filter((r) => failedIds.has(r.id)))
      setFailed(res.failed)
    })
  }

  return (
    <Dialog open onClose={onClose} className="max-w-lg" labelledBy={titleId}>
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/20">
          <TriangleAlert className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-[14px] font-[560] tracking-[-0.01em] text-foreground">
            {t('bulkTitle', { count: remaining.length })}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          className="-mr-1 -mt-1 grid size-7 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="space-y-4 px-5 py-4">
        {/* The batches about to disappear — coordinates (dataset → harness), scrollable when many. */}
        <div className="max-h-[240px] space-y-1.5 overflow-y-auto rounded-lg border border-border bg-muted/30 px-3 py-2.5">
          {remaining.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-1.5 text-[13px]">
              <EntityRef id={s.dataset.id} version={s.dataset.version} kind="dataset" />
              <span className="text-faint">→</span>
              <EntityRef id={s.harness.id} version={s.harness.version} kind="harness" />
            </div>
          ))}
        </div>

        <p className="text-[12.5px] leading-relaxed text-muted-foreground">{t('explain')}</p>

        <Callout tone="danger" className="py-2">
          {t('irreversible')}
        </Callout>

        {failed.length > 0 && (
          <Callout
            tone="danger"
            className="py-2"
            hint={failed.map((f) => `${f.id.slice(0, 8)}: ${f.error}`).join(' · ')}
          >
            {t('failedSome', { count: failed.length })}
          </Callout>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
          {t('cancel')}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={onConfirm}
          disabled={pending || remaining.length === 0}
        >
          {pending && <Loader2 className="size-3.5 animate-spin" />}
          {t('bulkConfirm', { count: remaining.length })}
        </Button>
      </div>
    </Dialog>
  )
}
