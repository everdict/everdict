'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { Project } from '@/entities/project'
import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { MultiSelect } from '@/shared/ui/multi-select'

import { deleteProjectAction, updateProjectAction } from '../api/projects'

// A list field counts as "unchanged" only when the ORDER matches too — the server replaces it wholesale with what it receives, so sending it
// when nothing changed leaves an empty change in the history.
function sameIds(next: readonly string[], previous: readonly string[]): boolean {
  return next.length === previous.length && next.every((id, i) => id === previous[i])
}

// PATCH semantics: `null` clears an optional field, `undefined` leaves it alone.
function cleared(next: string, previous: string | undefined): string | null | undefined {
  const trimmed = next.trim()
  if (trimmed === (previous ?? '')) return undefined
  return trimmed === '' ? null : trimmed
}

// Edit + delete. Deleting a project that still holds issues is a 409 at the control plane (it would orphan
// them) — the refusal is shown verbatim, since the fix is to move the issues, not to force anything.
export function ProjectActions({
  workspace,
  project,
  initiatives,
}: {
  workspace: string
  project: Project
  initiatives: { id: string; name: string }[]
}) {
  const t = useTranslations('projectsPage')
  const router = useRouter()
  const refresh = useRefresh()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')
  const [initiativeIds, setInitiativeIds] = useState<string[]>(project.initiativeIds)
  const [targetDate, setTargetDate] = useState(project.targetDate ?? '')
  const [pending, setPending] = useState(false)

  function save() {
    const patch = {
      ...(name.trim() !== project.name && name.trim() !== '' ? { name: name.trim() } : {}),
      ...(cleared(description, project.description) !== undefined
        ? { description: cleared(description, project.description) }
        : {}),
      ...(sameIds(initiativeIds, project.initiativeIds) ? {} : { initiativeIds }),
      ...(targetDate !== (project.targetDate ?? '')
        ? { targetDate: targetDate === '' ? null : targetDate }
        : {}),
    }
    if (Object.keys(patch).length === 0) {
      setEditing(false)
      return
    }
    void (async () => {
      setPending(true)
      try {
        const r = await updateProjectAction(project.id, patch)
        if (!r.ok) {
          toast.error(r.error ?? t('editError'))
          return
        }
        setEditing(false)
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  function remove() {
    void (async () => {
      setPending(true)
      try {
        const r = await deleteProjectAction(project.id)
        if (!r.ok) {
          toast.error(r.error ?? t('deleteError'))
          return
        }
        setConfirming(false)
        router.push(`/${workspace}/projects`)
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <>
      <DropdownMenu
        align="end"
        trigger={({ toggle, open }) => (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('actions')}
            aria-expanded={open}
            onClick={toggle}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        )}
      >
        <DropdownItem icon={<Pencil className="size-3.5" />} onSelect={() => setEditing(true)}>
          {t('edit')}
        </DropdownItem>
        <DropdownItem
          icon={<Trash2 className="size-3.5" />}
          tone="danger"
          onSelect={() => setConfirming(true)}
        >
          {t('delete')}
        </DropdownItem>
      </DropdownMenu>

      <Dialog open={editing} onClose={() => setEditing(false)} className="max-w-lg">
        <form
          className="@container space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <h2 className="text-[15px] font-[560] text-foreground">{t('editTitle')}</h2>
          <div className="space-y-1.5">
            <Label htmlFor="edit-project-name">{t('fieldName')}</Label>
            <Input id="edit-project-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-project-description">{t('fieldDescription')}</Label>
            <Textarea
              id="edit-project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="grid gap-3 @md:grid-cols-2">
            <div className="space-y-1.5">
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-project-initiative">{t('fieldInitiative')}</Label>
              <MultiSelect
                id="edit-project-initiative"
                selected={initiativeIds}
                onChange={setInitiativeIds}
                placeholder={t('fieldInitiativePlaceholder')}
                emptyLabel={t('fieldInitiativeEmpty')}
                removeLabel={(initiativeName) =>
                  t('fieldInitiativeRemove', { name: initiativeName })
                }
                options={initiatives.map((i) => ({ value: i.id, label: i.name }))}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-project-target">{t('fieldTargetDate')}</Label>
            <Input
              id="edit-project-target"
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : t('save')}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={confirming} onClose={() => setConfirming(false)} className="max-w-md">
        <div className="space-y-4 p-5">
          <h2 className="text-[15px] font-[560] text-foreground">{t('deleteTitle')}</h2>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t('deleteBody', { name: project.name })}
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setConfirming(false)}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" size="sm" disabled={pending} onClick={remove}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : t('delete')}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
