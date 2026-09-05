'use client'

import { useMemo, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { LabelChip, type IssueLabel } from '@/entities/issue-label'
import { useRefresh } from '@/shared/lib/use-refresh'
import { DropdownMenu } from '@/shared/ui/dropdown-menu'

import { updateIssueAction } from '../api/issues'
import { toggleLabelId, withCreatedLabels } from '../lib/label-selection'
import { IssueLabelOptions, RemovableLabelChip } from './issue-label-picker'

// An issue's labels — changed right where status, priority and team are (the attribute column). It used to draw the chips only, with editing
// living inside the ⋯ menu's dialog, and opening a whole issue form to remove one label is not Linear's path.
//
// Attaching and detaching save immediately (this is a control, not a form). The chips show as changed while the save is in flight, and on a
// refusal they roll back and show the control plane's reason verbatim.
export function IssueLabelControl({
  id,
  labelIds,
  labels,
  canWrite,
}: {
  id: string
  labelIds: string[]
  // The workspace label registry — both what can be picked and the basis for drawing the chips.
  labels: IssueLabel[]
  canWrite: boolean
}) {
  const t = useTranslations('issuesPage')
  const refresh = useRefresh()
  const [created, setCreated] = useState<IssueLabel[]>([])
  const [selected, setSelected] = useState(labelIds)
  const [seen, setSeen] = useState(labelIds.join(' '))
  const [pending, setPending] = useState(false)

  // What the SERVER carried is the truth — once a save finishes and the page re-renders, or another screen edits it, this follows.
  // It does not follow while a save is in flight: toggling twice in a row would make the first response undo the second choice and flicker.
  const fromServer = labelIds.join(' ')
  if (!pending && fromServer !== seen) {
    setSeen(fromServer)
    setSelected(labelIds)
  }

  const known = useMemo(() => withCreatedLabels(labels, created), [labels, created])
  const byId = useMemo(() => Object.fromEntries(known.map((l) => [l.id, l])), [known])
  // An id whose definition is gone is not drawn — it does not arise on the normal path, since deleting a label detaches its id from the issues too.
  const chips = selected.map((x) => byId[x]).filter((l): l is IssueLabel => l !== undefined)

  function apply(next: string[]): void {
    const previous = selected
    setSelected(next)
    void (async () => {
      setPending(true)
      try {
        const r = await updateIssueAction(id, { labelIds: next })
        if (!r.ok) {
          setSelected(previous)
          toast.error(r.error ?? t('labelsError'))
          return
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  if (!canWrite) {
    if (chips.length === 0) return null
    return (
      <span className="inline-flex flex-wrap items-center gap-1">
        {chips.map((label) => (
          <LabelChip key={label.id} label={label} />
        ))}
      </span>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1">
      {chips.map((label) => (
        <RemovableLabelChip
          key={label.id}
          label={label}
          disabled={pending}
          onRemove={() => apply(toggleLabelId(selected, label.id))}
          removeLabel={t('labelRemove', { name: label.name })}
        />
      ))}
      <DropdownMenu
        align="end"
        contentClassName="w-64 p-2"
        trigger={({ toggle, open }) => (
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-label={t('labelsControlLabel')}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground"
          >
            {pending ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
            {/* On an issue with nothing attached yet, this button is the only affordance — that is the only time it wears a label. */}
            {chips.length === 0 && <span>{t('labelAdd')}</span>}
          </button>
        )}
      >
        <IssueLabelOptions
          labels={known}
          selected={selected}
          canCreate
          autoFocus
          onToggle={(labelId) => apply(toggleLabelId(selected, labelId))}
          onCreated={(label) => {
            setCreated((prev) => [...prev, label])
            apply([...selected, label.id])
          }}
        />
      </DropdownMenu>
    </div>
  )
}
