'use client'

import { useState } from 'react'
import { File as FileIcon, Folder, Loader2, TriangleAlert, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'

import { removeEntriesAction } from '../api/browse-files'
import { displayPath, type FsTarget } from '../lib/fs-path'

// Confirm + fan-out for deleting workspace-filesystem entries. Deletion lives on the LIST (the tree row's trash
// and the multi-select action bar), not in the viewer — so this dialog serves both the single-row case and a
// whole selection with the same grammar as the scorecard bulk delete: a partial failure keeps the dialog open
// with only the failed entries left for retry. Mount only when open so state initializes fresh each time.
export function DeleteEntriesDialog({
  targets,
  onClose,
  onDeleted,
}: {
  targets: FsTarget[]
  onClose: () => void
  // The paths actually removed — the tree drops them from its selection and refetches, and the host closes an
  // open viewer whose file the deletion carried away.
  onDeleted: (paths: string[]) => void
}) {
  const t = useTranslations('files')
  const [pending, setPending] = useState(false)
  // Shrinks as entries are deleted, so a partial failure leaves only the still-present ones actionable.
  const [remaining, setRemaining] = useState<FsTarget[]>(targets)
  const [failed, setFailed] = useState<{ path: string; error: string }[]>([])
  const titleId = 'delete-fs-entries'
  const hasFolder = remaining.some((target) => target.kind === 'dir')

  function onConfirm() {
    if (pending || remaining.length === 0) return
    void (async () => {
      setPending(true)
      try {
        const res = await removeEntriesAction(
          remaining.map((target) => ({ path: target.path, recursive: target.kind === 'dir' }))
        )
        if (res.removed.length > 0) {
          toast.success(t('deletedMany', { count: res.removed.length }))
          onDeleted(res.removed)
        }
        if (res.failed.length === 0) {
          onClose()
          return
        }
        const failedPaths = new Set(res.failed.map((f) => f.path))
        setRemaining(remaining.filter((target) => failedPaths.has(target.path)))
        setFailed(res.failed)
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <Dialog open onClose={onClose} className="max-w-lg" labelledBy={titleId}>
      {/* Single-line title → centered compact header, matching its sibling MoveEntriesDialog (both open from the
          same selection action bar). The taller size-9 variant stays with the delete-* confirms that show an id line. */}
      <div className="flex items-center gap-2.5 border-b border-border px-5 py-3.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/20">
          <TriangleAlert className="size-4" />
        </span>
        <h2
          id={titleId}
          className="min-w-0 flex-1 truncate text-[14px] font-[560] tracking-[-0.01em] text-foreground"
        >
          {t('deleteEntriesTitle', { count: remaining.length })}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('close')}
          className="-mr-1 grid size-7 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="space-y-4 px-5 py-4">
        {/* What is about to disappear — full paths, scrollable when the selection is large. */}
        <div className="max-h-[240px] space-y-1 overflow-y-auto rounded-lg border border-border bg-muted/30 px-3 py-2.5">
          {remaining.map((target) => (
            <div
              key={target.path}
              className="flex items-center gap-1.5 font-mono text-[12.5px] text-foreground"
            >
              {target.kind === 'dir' ? (
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{displayPath(target.path)}</span>
            </div>
          ))}
        </div>

        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          {hasFolder ? t('deleteEntriesBodyFolders') : t('deleteEntriesBody')}
        </p>

        <Callout tone="danger" className="py-2">
          {t('deleteIrreversible')}
        </Callout>

        {failed.length > 0 && (
          <Callout
            tone="danger"
            className="py-2"
            hint={failed.map((f) => `${displayPath(f.path)}: ${f.error}`).join(' · ')}
          >
            {t('deleteFailedSome', { count: failed.length })}
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
          {t('deleteEntriesConfirm', { count: remaining.length })}
        </Button>
      </div>
    </Dialog>
  )
}
