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

import { deleteScorecardAction } from '../api/delete-scorecard'

// Delete-scorecard confirm dialog — same visual grammar as the harness/dataset/judge delete dialogs, but a
// scorecard has no versions: one destructive confirmation over the batch's coordinates (dataset → harness).
// Delete is a HARD delete (result record + child runs), so the copy spells out what disappears.
// Mount only when open (the parent gates with `{open && …}`) so state initializes fresh each time.
export function DeleteScorecardDialog({
  onClose,
  id,
  dataset,
  harness,
  workspace,
  afterDelete,
}: {
  onClose: () => void
  id: string
  dataset: { id: string; version: string }
  harness: { id: string; version: string }
  workspace: string
  // Detail-page entry navigates back to the list (the page is gone); list-row entry just refreshes in place.
  afterDelete: 'toList' | 'refresh'
}) {
  const t = useTranslations('deleteScorecard')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | undefined>(undefined)
  const titleId = `delete-scorecard-${id}`
  const shortId = id.slice(0, 8)

  function onConfirm() {
    if (pending) return
    startTransition(async () => {
      const res = await deleteScorecardAction({ id })
      if (!res.ok) {
        // Keep the dialog open on failure (permission / still-running conflict) and show why.
        setError(res.error)
        return
      }
      toast.success(t('deleted', { id: shortId }))
      if (afterDelete === 'toList') {
        router.push(`/${workspace}/scorecards`)
      }
      router.refresh()
      onClose()
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
            {t('title')}
          </h2>
          <p className="mt-0.5 truncate font-mono text-[12px] text-muted-foreground">
            scorecard {shortId}
          </p>
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
        {/* The batch's coordinates — what result is about to disappear. */}
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-[13px]">
          <EntityRef id={dataset.id} version={dataset.version} kind="dataset" />
          <span className="text-faint">→</span>
          <EntityRef id={harness.id} version={harness.version} kind="harness" />
        </div>

        <p className="text-[12.5px] leading-relaxed text-muted-foreground">{t('explain')}</p>

        <Callout tone="danger" className="py-2">
          {t('irreversible')}
        </Callout>

        {error && (
          <Callout tone="danger" className="py-2" hint={error}>
            {t('failed')}
          </Callout>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
          {t('cancel')}
        </Button>
        <Button variant="destructive" size="sm" onClick={onConfirm} disabled={pending}>
          {pending && <Loader2 className="size-3.5 animate-spin" />}
          {t('confirm')}
        </Button>
      </div>
    </Dialog>
  )
}
