'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { MultiSelect } from '@/shared/ui/multi-select'

import { createProjectAction } from '../api/projects'

export function CreateProjectButton({
  workspace,
  initiatives,
}: {
  workspace: string
  initiatives: { id: string; name: string }[]
}) {
  const t = useTranslations('projectsPage')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [initiativeIds, setInitiativeIds] = useState<string[]>([])
  const [targetDate, setTargetDate] = useState('')
  const [pending, setPending] = useState(false)

  function submit() {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    void (async () => {
      setPending(true)
      try {
        const r = await createProjectAction({
          name: trimmed,
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(initiativeIds.length > 0 ? { initiativeIds } : {}),
          ...(targetDate ? { targetDate } : {}),
        })
        if (!r.ok || !r.project) {
          toast.error(r.error ?? t('createError'))
          return
        }
        setOpen(false)
        setName('')
        setDescription('')
        setInitiativeIds([])
        setTargetDate('')
        router.push(`/${workspace}/project/${encodeURIComponent(r.project.id)}`)
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
            <Label htmlFor="project-name">{t('fieldName')}</Label>
            <Input
              id="project-name"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder={t('fieldNamePlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-description">{t('fieldDescription')}</Label>
            <Textarea
              id="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-initiative">{t('fieldInitiative')}</Label>
            <MultiSelect
              id="project-initiative"
              selected={initiativeIds}
              onChange={setInitiativeIds}
              placeholder={t('fieldInitiativePlaceholder')}
              emptyLabel={t('fieldInitiativeEmpty')}
              removeLabel={(name) => t('fieldInitiativeRemove', { name })}
              options={initiatives.map((i) => ({ value: i.id, label: i.name }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-target">{t('fieldTargetDate')}</Label>
            <Input
              id="project-target"
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
