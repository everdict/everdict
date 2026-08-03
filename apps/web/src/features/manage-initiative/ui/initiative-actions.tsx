'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { Initiative } from '@/entities/initiative'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Input, Label, Textarea } from '@/shared/ui/input'

import { deleteInitiativeAction, updateInitiativeAction } from '../api/initiatives'

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
  // 상위 후보 — 자기 자신은 뺀다. 자기 하위로 옮기는 시도는 제어 평면이 409 로 거절하므로, 여기서는
  // 명백히 불가능한 선택지(자기 자신)만 지운다.
  initiatives: { id: string; name: string }[]
  // 책임자 후보 — 워크스페이스 멤버. 이름은 화면이 이미 갖고 있으므로(멤버 디렉터리) 여기서는 고를 목록만
  // 받는다.
  members: { subject: string; name: string }[]
}) {
  const t = useTranslations('initiativesPage')
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [name, setName] = useState(initiative.name)
  const [description, setDescription] = useState(initiative.description ?? '')
  const [parentId, setParentId] = useState(initiative.parentId ?? '')
  const [lead, setLead] = useState(initiative.lead ?? '')
  const [targetDate, setTargetDate] = useState(initiative.targetDate ?? '')
  const [pending, startTransition] = useTransition()

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
      ...(targetDate !== (initiative.targetDate ?? '')
        ? { targetDate: targetDate === '' ? null : targetDate }
        : {}),
    }
    if (Object.keys(patch).length === 0) {
      setEditing(false)
      return
    }
    startTransition(async () => {
      const r = await updateInitiativeAction(initiative.id, patch)
      if (!r.ok) {
        toast.error(r.error ?? t('editError'))
        return
      }
      setEditing(false)
      router.refresh()
    })
  }

  function remove() {
    startTransition(async () => {
      const r = await deleteInitiativeAction(initiative.id)
      if (!r.ok) {
        toast.error(r.error ?? t('deleteError'))
        return
      }
      setConfirming(false)
      router.push(`/${workspace}/initiatives`)
    })
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
