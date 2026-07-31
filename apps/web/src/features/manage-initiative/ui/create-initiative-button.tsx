'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label, Textarea } from '@/shared/ui/input'

import { createInitiativeAction } from '../api/initiatives'

export function CreateInitiativeButton({ workspace }: { workspace: string }) {
  const t = useTranslations('initiativesPage')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [targetDate, setTargetDate] = useState('')
  const [pending, startTransition] = useTransition()

  function submit() {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    startTransition(async () => {
      const r = await createInitiativeAction({
        name: trimmed,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(targetDate ? { targetDate } : {}),
      })
      if (!r.ok || !r.initiative) {
        toast.error(r.error ?? t('createError'))
        return
      }
      setOpen(false)
      setName('')
      setDescription('')
      setTargetDate('')
      router.push(`/${workspace}/initiatives/${encodeURIComponent(r.initiative.id)}`)
    })
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" />
        {t('create')}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} className="max-w-lg">
        <form
          className="@container space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <h2 className="text-[15px] font-[560] text-foreground">{t('createTitle')}</h2>
          <div className="space-y-1.5">
            <Label htmlFor="initiative-name">{t('fieldName')}</Label>
            <Input
              id="initiative-name"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder={t('fieldNamePlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="initiative-description">{t('fieldDescription')}</Label>
            <Textarea
              id="initiative-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="initiative-target">{t('fieldTargetDate')}</Label>
            <Input
              id="initiative-target"
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={pending || name.trim().length === 0}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : t('create')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  )
}
