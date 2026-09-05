'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, MoreHorizontal, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { Initiative, InitiativeResource } from '@/entities/initiative'
import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { MultiSelect } from '@/shared/ui/multi-select'

import { deleteInitiativeAction, updateInitiativeAction } from '../api/initiatives'

// A half-written row is not saved — a resource with no address is not a link.
function cleanResources(rows: readonly InitiativeResource[]): InitiativeResource[] {
  return rows
    .map((row) => ({ label: row.label.trim(), url: row.url.trim() }))
    .filter((row) => row.label !== '' && row.url !== '')
}

function sameResources(
  a: readonly InitiativeResource[],
  b: readonly InitiativeResource[]
): boolean {
  return (
    a.length === b.length && a.every((row, i) => row.label === b[i]?.label && row.url === b[i]?.url)
  )
}

function cleared(next: string, previous: string | undefined): string | null | undefined {
  const trimmed = next.trim()
  if (trimmed === (previous ?? '')) return undefined
  return trimmed === '' ? null : trimmed
}

// Edit + delete. An initiative that still holds projects refuses deletion with a 409 rather than orphaning
// them, so the refusal is surfaced verbatim.
export function InitiativeActions({
  workspace,
  initiative,
  initiatives,
  members,
}: {
  workspace: string
  initiative: Initiative
  // The parent candidates — itself excluded. Trying to move under its own descendant is refused by the control plane with a 409, so only the
  // plainly impossible choice (itself) is removed here.
  initiatives: { id: string; name: string }[]
  // The lead candidates — workspace members. The screen already has the names (the member directory), so only the list to choose from is
  // received here.
  members: { subject: string; name: string }[]
}) {
  const t = useTranslations('initiativesPage')
  const router = useRouter()
  const refresh = useRefresh()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [name, setName] = useState(initiative.name)
  const [description, setDescription] = useState(initiative.description ?? '')
  const [parentId, setParentId] = useState(initiative.parentId ?? '')
  const [lead, setLead] = useState(initiative.lead ?? '')
  const [icon, setIcon] = useState(initiative.icon ?? '')
  const [memberIds, setMemberIds] = useState<string[]>(initiative.memberIds)
  // One empty row is not left standing permanently — the add button creates a row. On save, a row with an empty label or address is discarded.
  const [resources, setResources] = useState<InitiativeResource[]>(initiative.resources)
  const [targetDate, setTargetDate] = useState(initiative.targetDate ?? '')
  const [pending, setPending] = useState(false)

  function save() {
    const patch = {
      ...(name.trim() !== initiative.name && name.trim() !== '' ? { name: name.trim() } : {}),
      ...(cleared(description, initiative.description) !== undefined
        ? { description: cleared(description, initiative.description) }
        : {}),
      ...(parentId !== (initiative.parentId ?? '')
        ? { parentId: parentId === '' ? null : parentId }
        : {}),
      ...(lead !== (initiative.lead ?? '') ? { lead: lead === '' ? null : lead } : {}),
      ...(icon.trim() !== (initiative.icon ?? '')
        ? { icon: icon.trim() === '' ? null : icon.trim() }
        : {}),
      ...(memberIds.join('\u0000') !== initiative.memberIds.join('\u0000') ? { memberIds } : {}),
      ...(sameResources(cleanResources(resources), initiative.resources)
        ? {}
        : { resources: cleanResources(resources) }),
      ...(targetDate !== (initiative.targetDate ?? '')
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
        const r = await updateInitiativeAction(initiative.id, patch)
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
        const r = await deleteInitiativeAction(initiative.id)
        if (!r.ok) {
          toast.error(r.error ?? t('deleteError'))
          return
        }
        setConfirming(false)
        router.push(`/${workspace}/initiatives`)
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
            <Label htmlFor="edit-initiative-name">{t('fieldName')}</Label>
            <Input
              id="edit-initiative-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-initiative-description">{t('fieldDescription')}</Label>
            <Textarea
              id="edit-initiative-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-initiative-parent">{t('fieldParent')}</Label>
            <Combobox
              id="edit-initiative-parent"
              value={parentId}
              onChange={setParentId}
              placeholder={t('fieldParentNone')}
              options={[
                { value: '', label: t('fieldParentNone') },
                ...initiatives
                  .filter((i) => i.id !== initiative.id)
                  .map((i) => ({ value: i.id, label: i.name })),
              ]}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-initiative-icon">{t('fieldIcon')}</Label>
            <Input
              id="edit-initiative-icon"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder={t('fieldIconPlaceholder')}
              className="w-24"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-initiative-lead">{t('fieldLead')}</Label>
            <Combobox
              id="edit-initiative-lead"
              value={lead}
              onChange={setLead}
              placeholder={t('fieldLeadNone')}
              options={[
                { value: '', label: t('fieldLeadNone') },
                ...members.map((m) => ({ value: m.subject, label: m.name })),
              ]}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-initiative-members">{t('fieldMembers')}</Label>
            <MultiSelect
              id="edit-initiative-members"
              options={members.map((m) => ({ value: m.subject, label: m.name }))}
              selected={memberIds}
              onChange={setMemberIds}
              placeholder={t('fieldMembersPlaceholder')}
              emptyLabel={t('fieldMembersEmpty')}
              removeLabel={(name) => t('fieldMembersRemove', { name })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t('fieldResources')}</Label>
            <p className="text-[12px] leading-relaxed text-muted-foreground">{t('resourceHint')}</p>
            <div className="space-y-1.5">
              {resources.map((resource, index) => (
                <div key={`resource-${index}`} className="flex flex-col gap-1.5 @sm:flex-row">
                  <Input
                    value={resource.label}
                    onChange={(e) =>
                      setResources((rows) =>
                        rows.map((row, i) =>
                          i === index ? { ...row, label: e.target.value } : row
                        )
                      )
                    }
                    placeholder={t('fieldResourceLabel')}
                    className="min-w-0 flex-1"
                  />
                  <Input
                    value={resource.url}
                    onChange={(e) =>
                      setResources((rows) =>
                        rows.map((row, i) => (i === index ? { ...row, url: e.target.value } : row))
                      )
                    }
                    placeholder={t('fieldResourceUrl')}
                    className="min-w-0 flex-1"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('resourceRemove', {
                      label: resource.label || t('fieldResources'),
                    })}
                    onClick={() => setResources((rows) => rows.filter((_, i) => i !== index))}
                  >
                    <X className="size-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setResources((rows) => [...rows, { label: '', url: '' }])}
              >
                <Plus className="size-3.5" />
                {t('resourceAdd')}
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-initiative-target">{t('fieldTargetDate')}</Label>
            <Input
              id="edit-initiative-target"
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
            {t('deleteBody', { name: initiative.name })}
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
