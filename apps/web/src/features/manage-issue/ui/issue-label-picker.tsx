'use client'

import { useMemo, useState } from 'react'
import { Check, Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { createIssueLabelAction } from '@/features/manage-issue-labels'
import {
  LabelColorPicker,
  LabelDot,
  suggestLabelColor,
  type IssueLabel,
  type IssueLabelColor,
} from '@/entities/issue-label'
import { cn } from '@/shared/lib/utils'
import { Input } from '@/shared/ui/input'

import { toggleLabelId, withCreatedLabels } from '../lib/label-selection'

// A removable label chip. Where a label is attached and where it is removed have to be the same place — people are not made to reopen the list and untick.
export function RemovableLabelChip({
  label,
  onRemove,
  removeLabel,
  disabled,
}: {
  label: IssueLabel
  onRemove: () => void
  removeLabel: string
  disabled?: boolean
}) {
  return (
    <span
      title={label.description ?? label.name}
      className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border py-0.5 pl-2 pr-1 text-[11.5px] text-muted-foreground"
    >
      <LabelDot color={label.color} />
      <span className="truncate">{label.name}</span>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={removeLabel}
        className="rounded-full p-0.5 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

// The choices — search · the list · (for a name that does not exist) define it on the spot. The point is that it is PICKED from the workspace
// registry rather than free text (a label is a record now). Still, so as not to block the "I just thought of a name that does not exist yet"
// flow, a search term matching no label can be created right there — the same path as Linear.
//
// The registry is held by the PARENT: a label just created has to be drawn as a chip too, and with that list living only here the two copies
// diverge. So a created label is raised through `onCreated` and the parent registers and selects it together.
export function IssueLabelOptions({
  labels,
  selected,
  onToggle,
  onCreated,
  canCreate,
  autoFocus,
}: {
  labels: IssueLabel[]
  selected: string[]
  onToggle: (id: string) => void
  onCreated: (label: IssueLabel) => void
  // Defining a label is issues:write — for someone without it the create row is not drawn at all.
  canCreate: boolean
  autoFocus?: boolean
}) {
  const t = useTranslations('issuesPage')
  const [query, setQuery] = useState('')
  // With no colour picked, the colour suggested from the name is used — not picking and picking grey are different (the former keeps following
  // the name as it is retyped, the latter has to stay put).
  const [picked, setPicked] = useState<IssueLabelColor | undefined>()
  const [pending, setPending] = useState(false)

  const needle = query.trim().toLocaleLowerCase()
  const choices = labels.filter(
    (l) =>
      !selected.includes(l.id) && (needle === '' || l.name.toLocaleLowerCase().includes(needle))
  )
  // With an exactly matching name already present the create row is not drawn — nothing is suggested that the server would refuse with a 409.
  const exact = labels.some((l) => l.name.trim().toLocaleLowerCase() === needle)
  const offerCreate = canCreate && needle.length > 0 && !exact
  const color = picked ?? suggestLabelColor(query)

  function create(): void {
    const name = query.trim()
    if (name.length === 0) return
    void (async () => {
      setPending(true)
      try {
        const r = await createIssueLabelAction({ name, color })
        if (!r.ok || !r.label) {
          toast.error(r.error ?? t('labelCreateError'))
          return
        }
        onCreated(r.label)
        setQuery('')
        setPicked(undefined)
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <div className="space-y-2">
      <Input
        value={query}
        autoFocus={autoFocus}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('labelSearchPlaceholder')}
        onKeyDown={(e) => {
          // An Enter that submits the form would save the issue mid-label-selection.
          if (e.key === 'Enter') {
            e.preventDefault()
            if (offerCreate) create()
          }
        }}
      />
      <div className="max-h-40 space-y-0.5 overflow-y-auto">
        {choices.map((label) => (
          <button
            key={label.id}
            type="button"
            onClick={() => onToggle(label.id)}
            className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <LabelDot color={label.color} />
            <span className="min-w-0 flex-1 truncate">{label.name}</span>
            {selected.includes(label.id) && <Check className="size-3.5" />}
          </button>
        ))}
        {offerCreate && (
          // The create row is where the COLOUR is decided too — leaving colour to a later settings screen makes every new label born the same
          // colour. The dot shows exactly the colour it would be created with.
          <div className="space-y-1.5 rounded-md border border-border/70 p-1.5">
            <button
              type="button"
              onClick={create}
              disabled={pending}
              className={cn(
                'flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[12.5px] text-link transition-colors hover:bg-accent hover:text-foreground',
                pending && 'opacity-60'
              )}
            >
              <Plus className="size-3.5" />
              <span className="truncate">{t('labelCreate', { name: query.trim() })}</span>
              <LabelDot color={color} />
            </button>
            <LabelColorPicker
              size="sm"
              value={color}
              onChange={setPicked}
              ariaLabel={t('labelColorLabel')}
            />
          </div>
        )}
        {choices.length === 0 && !offerCreate && (
          <p className="px-1.5 py-1 text-[12px] text-faint">{t('labelNoMatch')}</p>
        )}
      </div>
    </div>
  )
}

// A Linear-style label selector — what is selected sits above as chips, what can be chosen in the list below. For a form field (the FORM saves);
// attaching and detaching directly from the detail screen's attribute column is `IssueLabelControl`.
export function IssueLabelPicker({
  labels,
  selected,
  onChange,
  canCreate,
}: {
  labels: IssueLabel[]
  selected: string[]
  onChange: (next: string[]) => void
  canCreate: boolean
}) {
  const t = useTranslations('issuesPage')
  const [created, setCreated] = useState<IssueLabel[]>([])

  const known = useMemo(() => withCreatedLabels(labels, created), [labels, created])
  const byId = useMemo(() => Object.fromEntries(known.map((l) => [l.id, l])), [known])
  const chips = selected.map((id) => byId[id]).filter((l): l is IssueLabel => l !== undefined)

  return (
    <div className="space-y-2">
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chips.map((label) => (
            <RemovableLabelChip
              key={label.id}
              label={label}
              onRemove={() => onChange(toggleLabelId(selected, label.id))}
              removeLabel={t('labelRemove', { name: label.name })}
            />
          ))}
        </div>
      )}
      <IssueLabelOptions
        labels={known}
        selected={selected}
        onToggle={(id) => onChange(toggleLabelId(selected, id))}
        onCreated={(label) => {
          setCreated((prev) => [...prev, label])
          onChange([...selected, label.id])
        }}
        canCreate={canCreate}
      />
    </div>
  )
}
