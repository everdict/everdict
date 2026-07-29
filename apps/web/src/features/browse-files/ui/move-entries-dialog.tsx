'use client'

import { useMemo, useState, useTransition } from 'react'
import { CornerDownRight, File as FileIcon, Folder, Loader2, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Label } from '@/shared/ui/input'

import { moveEntriesAction } from '../api/browse-files'
import { baseNameOf, displayPath, joinFsPath, movablePaths, type FsTarget } from '../lib/fs-path'

// Bulk relocation for a tree selection. Dragging is still the direct gesture (and the only one for a single
// entry), but it can't reach a folder that is scrolled away or collapsed — this picks the destination from the
// folders the tree knows instead. Only destinations that would actually accept something are offered
// (movablePaths), and entries already sitting in the chosen folder are skipped rather than failed.
export function MoveEntriesDialog({
  sources,
  directories,
  onClose,
  onMoved,
}: {
  sources: FsTarget[]
  // Every folder the tree has loaded, as canonical paths (root is added here, not by the caller).
  directories: string[]
  onClose: () => void
  onMoved: (moves: { from: string; to: string }[]) => void
}) {
  const t = useTranslations('files')
  const [pending, startTransition] = useTransition()
  const [destination, setDestination] = useState('')
  const [failed, setFailed] = useState<{ path: string; error: string }[]>([])
  const titleId = 'move-fs-entries'

  const sourcePaths = useMemo(() => sources.map((source) => source.path), [sources])
  // Root first, then the loaded folders — each kept only if at least one selected entry could land there.
  const options = useMemo(
    () =>
      ['', ...[...new Set(directories)].sort()]
        .filter((dir) => movablePaths(dir, sourcePaths).length > 0)
        .map((dir) => ({ value: dir, label: dir === '' ? t('moveRoot') : displayPath(dir) })),
    [directories, sourcePaths, t]
  )

  const movable = movablePaths(destination, sourcePaths)
  const skipped = sourcePaths.length - movable.length

  function onConfirm() {
    if (pending || movable.length === 0) return
    startTransition(async () => {
      const res = await moveEntriesAction(
        movable.map((from) => ({ from, to: joinFsPath(destination, baseNameOf(from)) }))
      )
      if (res.moved.length > 0) {
        toast.success(t('movedMany', { count: res.moved.length }))
        onMoved(res.moved)
      }
      if (res.failed.length === 0) {
        onClose()
        return
      }
      setFailed(res.failed)
    })
  }

  return (
    <Dialog open onClose={onClose} className="max-w-lg" labelledBy={titleId}>
      {/* The title is a single line, so the row centers on it. The taller `items-start` + size-9 badge header
          belongs to the delete-* confirms that carry a second line (the id) under the title — borrowing it here
          just left the title floating at the top of an oversized header. */}
      <div className="flex items-center gap-2.5 border-b border-border px-5 py-3.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
          <CornerDownRight className="size-4" />
        </span>
        <h2
          id={titleId}
          className="min-w-0 flex-1 truncate text-[14px] font-[560] tracking-[-0.01em] text-foreground"
        >
          {t('moveTitle', { count: sources.length })}
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
        <div className="max-h-[180px] space-y-1 overflow-y-auto rounded-lg border border-border bg-muted/30 px-3 py-2.5">
          {sources.map((source) => (
            <div
              key={source.path}
              className="flex items-center gap-1.5 font-mono text-[12.5px] text-foreground"
            >
              {source.kind === 'dir' ? (
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{displayPath(source.path)}</span>
            </div>
          ))}
        </div>

        {options.length === 0 ? (
          <Callout tone="muted" className="py-2">
            {t('moveNoDestination')}
          </Callout>
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="fs-move-destination">{t('moveDestination')}</Label>
            <Combobox
              id="fs-move-destination"
              options={options}
              value={destination}
              onChange={(value) => {
                setDestination(value)
                setFailed([])
              }}
              className="w-full"
            />
            {skipped > 0 && (
              <p className="text-[12px] text-muted-foreground">
                {t('moveSkipped', { count: skipped })}
              </p>
            )}
          </div>
        )}

        {failed.length > 0 && (
          <Callout
            tone="danger"
            className="py-2"
            hint={failed.map((f) => `${displayPath(f.path)}: ${f.error}`).join(' · ')}
          >
            {t('moveFailedSome', { count: failed.length })}
          </Callout>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={pending}>
          {t('cancel')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onConfirm}
          disabled={pending || movable.length === 0}
        >
          {pending && <Loader2 className="size-3.5 animate-spin" />}
          {t('moveConfirm', { count: movable.length })}
        </Button>
      </div>
    </Dialog>
  )
}
