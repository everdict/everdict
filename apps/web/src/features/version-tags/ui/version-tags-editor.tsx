'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import { VersionTagChip } from '@/shared/ui/chip'

import { setVersionTagsAction, type VersionTagEntity } from '../api/set-version-tags'

// Tag chip list for one "version" + inline editing (add/remove) — shared by the harness/dataset/runtime detail views.
// Tag = a free-form label attached when a version is hard to tell apart by number alone (mutable meta outside the spec — unrelated to version immutability).
// canEdit=false is display-only (chips only). When not editable and there are no tags, the caller hides the row itself (no empty section shown).
export function VersionTagsEditor({
  entity,
  id,
  version,
  tags,
  canEdit,
}: {
  entity: VersionTagEntity
  id: string
  version: string
  tags: string[]
  canEdit: boolean
}) {
  const router = useRouter()
  const tr = useTranslations('versionTags')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  const apply = (next: string[]) =>
    startTransition(async () => {
      const res = await setVersionTagsAction({ entity, id, version, tags: next })
      if (!res.ok) {
        setError(res.error ?? tr('saveFailed'))
        return
      }
      setError(undefined)
      setAdding(false)
      setDraft('')
      router.refresh()
    })

  const addDraft = () => {
    const tag = draft.trim()
    if (!tag) {
      setAdding(false)
      setDraft('')
      return
    }
    if (tags.includes(tag)) {
      setAdding(false)
      setDraft('')
      return
    }
    apply([...tags, tag])
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {tags.map((t) => (
        <VersionTagChip
          key={t}
          trailing={
            canEdit ? (
              <button
                type="button"
                aria-label={tr('deleteTag', { tag: t })}
                disabled={pending}
                onClick={() => apply(tags.filter((x) => x !== t))}
                className="ml-0.5 rounded text-faint transition-colors hover:text-foreground disabled:opacity-50"
              >
                <X className="size-3" />
              </button>
            ) : undefined
          }
        >
          {t}
        </VersionTagChip>
      ))}
      {canEdit &&
        (adding ? (
          <input
            autoFocus
            value={draft}
            disabled={pending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addDraft()
              if (e.key === 'Escape') {
                setAdding(false)
                setDraft('')
              }
            }}
            onBlur={addDraft}
            maxLength={60}
            placeholder={tr('placeholder')}
            aria-label={tr('newTag')}
            className="h-6 w-32 rounded border border-border bg-transparent px-1.5 text-[11px] text-foreground outline-none placeholder:text-faint focus:border-ring"
          />
        ) : (
          <button
            type="button"
            disabled={pending}
            onClick={() => setAdding(true)}
            className={cn(
              'inline-flex items-center gap-0.5 rounded border border-dashed border-border px-1.5 py-0.5',
              'text-[11px] text-faint transition-colors hover:border-ring hover:text-foreground disabled:opacity-50'
            )}
          >
            <Plus className="size-3" />
            {tr('tag')}
          </button>
        ))}
      {error && <span className="text-[11px] text-[var(--color-danger)]">{error}</span>}
    </div>
  )
}
