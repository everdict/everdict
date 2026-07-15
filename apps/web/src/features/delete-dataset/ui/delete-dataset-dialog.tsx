'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Loader2, TriangleAlert, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'

import { deleteDatasetVersionsAction } from '../api/delete-dataset'

// Custom checkbox glyph (no shared atom exists) — a small square that fills indigo with a check when selected.
function CheckBox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded border transition-colors',
        checked
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border-strong bg-transparent'
      )}
    >
      {checked && <Check className="size-3" strokeWidth={3} />}
    </span>
  )
}

// Delete-dataset dialog — pick any subset of versions (or select all = delete the whole dataset) and soft-delete them.
// Mount only when open (the parent gates with `{open && …}`) so state initializes fresh each time.
// Single version = check one, several = check several, whole dataset = select all — one surface for all three. The
// control-plane delete is atomic (fail-fast): if any selected version is forbidden/absent, nothing is deleted and the
// error is shown so the user can adjust the selection.
export function DeleteDatasetDialog({
  onClose,
  id,
  versions,
  latest,
  workspace,
  versionTags = {},
}: {
  onClose: () => void
  id: string
  // Live versions in the detail page's order (newest first).
  versions: string[]
  latest: string
  workspace: string
  versionTags?: Record<string, string[]>
}) {
  const t = useTranslations('deleteDataset')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string>()

  const selectedList = versions.filter((v) => selected.has(v))
  const allSelected = versions.length > 0 && selectedList.length === versions.length
  const deletesEntire = allSelected // every live version selected → the dataset disappears
  const titleId = `delete-dataset-${id}`

  function toggle(v: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(v)) next.delete(v)
      else next.add(v)
      return next
    })
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(versions))
  }

  function onConfirm() {
    if (selectedList.length === 0 || pending) return
    setError(undefined)
    startTransition(async () => {
      // Whole-dataset delete = every live version selected → omit `versions` for the clean "delete all" path.
      const res = await deleteDatasetVersionsAction({
        id,
        ...(deletesEntire ? {} : { versions: selectedList }),
      })
      if (!res.ok) {
        setError(res.error ?? t('deleteFailed'))
        return
      }
      if (deletesEntire) {
        toast.success(t('deletedDataset', { id }))
        router.push(`/${workspace}/datasets`)
      } else {
        toast.success(t('deletedVersions', { count: res.deleted.length, id }))
        // Land on the dataset (latest remaining version) rather than a possibly-deleted ?version= URL.
        router.push(`/${workspace}/datasets/${encodeURIComponent(id)}`)
      }
      router.refresh()
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
          <p className="mt-0.5 truncate font-mono text-[12px] text-muted-foreground">{id}</p>
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
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">{t('explain')}</p>

        {/* Select-all row */}
        <button
          type="button"
          onClick={toggleAll}
          disabled={pending}
          className="flex w-full items-center gap-2.5 rounded-md px-1 py-1 text-left text-[12.5px] font-[510] text-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          <CheckBox checked={allSelected} />
          <span className="flex-1">{t('selectAll')}</span>
          <span className="text-[11.5px] tabular-nums text-faint">
            {t('selectedOfTotal', { selected: selectedList.length, total: versions.length })}
          </span>
        </button>

        {/* Version checklist */}
        <div className="max-h-[280px] overflow-y-auto rounded-lg border border-border">
          {versions.map((v) => {
            const checked = selected.has(v)
            const tags = versionTags[v] ?? []
            return (
              <button
                type="button"
                key={v}
                onClick={() => toggle(v)}
                disabled={pending}
                aria-pressed={checked}
                className={cn(
                  'flex w-full items-center gap-2.5 border-b border-border px-3 py-2.5 text-left transition-colors last:border-b-0 disabled:opacity-50',
                  checked ? 'bg-destructive/[0.06]' : 'hover:bg-accent'
                )}
              >
                <CheckBox checked={checked} />
                <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11.5px] text-secondary-foreground">
                  v{v}
                </code>
                {v === latest && <span className="text-[11px] text-faint">{t('latest')}</span>}
                {tags.length > 0 && (
                  <span className="flex min-w-0 flex-wrap items-center gap-1">
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        className="truncate rounded bg-muted/50 px-1.5 py-0.5 text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border"
                      >
                        {tag}
                      </span>
                    ))}
                  </span>
                )}
              </button>
            )
          })}
        </div>

        {deletesEntire && (
          <Callout tone="danger" className="py-2">
            {t('entireWarning', { count: versions.length })}
          </Callout>
        )}

        {error && (
          <Callout tone="danger" className="py-2">
            {error}
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
          disabled={pending || selectedList.length === 0}
        >
          {pending && <Loader2 className="size-3.5 animate-spin" />}
          {deletesEntire
            ? t('confirmEntire')
            : t('confirmVersions', { count: selectedList.length })}
        </Button>
      </div>
    </Dialog>
  )
}
