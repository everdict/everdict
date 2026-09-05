'use client'

import { useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { isPastDue } from '@/entities/project'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label, Textarea } from '@/shared/ui/input'

import { createInitiativeAction } from '../api/initiatives'

export function CreateInitiativeButton({
  workspace,
  timeZone,
  initiatives,
}: {
  workspace: string
  // The initiatives it can hang from. It is a place that picks ONE, so a Combobox — unlike a project's teams and initiatives, a parent
  // is singular.
  initiatives: { id: string; name: string }[]
  // The basis for judging whether the target date has already passed. It has to use the same timezone as the list's "overdue" badge, or why
  // something just created shows as overdue does not add up.
  timeZone: string
}) {
  const t = useTranslations('initiativesPage')
  const router = useRouter()
  // This button sits in two places, the header and the empty state — the field ids are split per instance so two of them never share an id.
  const formId = useId()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [parentId, setParentId] = useState('')
  const [icon, setIcon] = useState('')
  const [targetDate, setTargetDate] = useState('')
  const [pending, setPending] = useState(false)

  // A past date IS accepted — recording a deadline already missed is legitimate. It simply says, before saving, that it will show as
  // "overdue" the moment it is created.
  const targetIsPast = isPastDue(targetDate === '' ? undefined : targetDate, timeZone)

  function submit() {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    void (async () => {
      setPending(true)
      try {
        const r = await createInitiativeAction({
          name: trimmed,
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(parentId ? { parentId } : {}),
          ...(icon.trim() ? { icon: icon.trim() } : {}),
          ...(targetDate ? { targetDate } : {}),
        })
        if (!r.ok || !r.initiative) {
          toast.error(r.error ?? t('createError'))
          return
        }
        setOpen(false)
        setName('')
        setDescription('')
        setParentId('')
        setIcon('')
        setTargetDate('')
        router.push(`/${workspace}/initiative/${encodeURIComponent(r.initiative.id)}`)
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        {t('create')}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        className="max-w-lg"
        labelledBy={`${formId}-title`}
      >
        <form
          className="@container space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <h2 id={`${formId}-title`} className="text-[15px] font-[560] text-foreground">
            {t('createTitle')}
          </h2>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-name`}>{t('fieldName')}</Label>
            <Input
              id={`${formId}-name`}
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder={t('fieldNamePlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-description`}>{t('fieldDescription')}</Label>
            <Textarea
              id={`${formId}-description`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('fieldDescriptionPlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-icon`}>{t('fieldIcon')}</Label>
            <Input
              id={`${formId}-icon`}
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder={t('fieldIconPlaceholder')}
              className="w-24"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-parent`}>{t('fieldParent')}</Label>
            <Combobox
              id={`${formId}-parent`}
              value={parentId}
              onChange={setParentId}
              placeholder={t('fieldParentNone')}
              options={[
                { value: '', label: t('fieldParentNone') },
                ...initiatives.map((i) => ({ value: i.id, label: i.name })),
              ]}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-target`}>{t('fieldTargetDate')}</Label>
            <Input
              id={`${formId}-target`}
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
            />
            {targetIsPast && (
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                {t('fieldTargetDatePast')}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
            {/* The submit label has to differ from the trigger ("new initiative") — identical text distinguishes what you are pressing only by
                WHERE you press. The label is kept during submission too, so the button width does not jump. */}
            <Button type="submit" size="sm" disabled={pending || name.trim().length === 0}>
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              {t('createSubmit')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  )
}
