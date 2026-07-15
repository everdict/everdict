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

import { deleteHarnessVersionsAction } from '../api/delete-harness'

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

// Delete-harness dialog — pick any subset of versions (or select all = delete the whole harness) and soft-delete them.
// Mount only when open (the parent gates with `{open && …}`) so state initializes fresh each time.
// Single version = check one, several = check several, whole harness = select all — one surface for all three.
export function DeleteHarnessDialog({
  onClose,
  id,
  versions,
  latest,
  workspace,
  versionTags = {},
  defaultAllSelected = false,
}: {
  onClose: () => void
  id: string
  // Live versions (newest last, matching the detail page's ordering).
  versions: string[]
  latest: string
  workspace: string
  versionTags?: Record<string, string[]>
  // List-row entry point opens with everything selected (delete-whole-harness intent); the detail header opens with none.
  defaultAllSelected?: boolean
}) {
  const t = useTranslations('deleteHarness')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  // Shrinks as versions are deleted (so a partial failure leaves the still-present ones actionable).
  const [remaining, setRemaining] = useState<string[]>(versions)
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(defaultAllSelected ? versions : [])
  )
  const [failed, setFailed] = useState<{ version: string; error: string }[]>([])

  const selectedList = remaining.filter((v) => selected.has(v))
  const allSelected = remaining.length > 0 && selectedList.length === remaining.length
  const deletesEntire = allSelected // every live version selected → the harness disappears
  const titleId = `delete-harness-${id}`

  function toggle(v: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(v)) next.delete(v)
      else next.add(v)
      return next
    })
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(remaining))
  }

  function onConfirm() {
    const targets = remaining.filter((v) => selected.has(v))
    if (targets.length === 0 || pending) return
    startTransition(async () => {
      const res = await deleteHarnessVersionsAction({ id, versions: targets })
      const stillHere = remaining.filter((v) => !res.deleted.includes(v))

      if (res.deleted.length > 0) {
        // The harness is gone once no live versions remain → return to the list; otherwise refresh in place.
        if (stillHere.length === 0) {
          toast.success(t('deletedHarness', { id }))
          router.push(`/${workspace}/harnesses`)
          router.refresh()
          return
        }
        toast.success(t('deletedVersions', { count: res.deleted.length, id }))
        router.refresh()
      }

      if (res.failed.length === 0) {
        onClose()
        return
      }
      // Keep the dialog open on partial failure — drop the deleted rows, keep the failed ones selected for retry, show why.
      setRemaining(stillHere)
      setSelected(new Set(res.failed.map((f) => f.version)))
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
            {t('selectedOfTotal', { selected: selectedList.length, total: remaining.length })}
          </span>
        </button>

        {/* Version checklist */}
        <div className="max-h-[280px] overflow-y-auto rounded-lg border border-border">
          {remaining.map((v) => {
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
            {t('entireWarning', { count: remaining.length })}
          </Callout>
        )}

        {failed.length > 0 && (
          <Callout
            tone="danger"
            className="py-2"
            hint={failed.map((f) => `v${f.version}: ${f.error}`).join(' · ')}
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
