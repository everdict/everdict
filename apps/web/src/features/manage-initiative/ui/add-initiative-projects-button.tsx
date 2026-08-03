'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { Label } from '@/shared/ui/input'
import { MultiSelect } from '@/shared/ui/multi-select'

import { addProjectsToInitiativeAction } from '../api/initiatives'

// "What else counts toward this goal" — asked and answered on the goal's own screen. The link is still a field
// on the project, so this picker offers EXISTING projects rather than creating one: a goal is a way of grouping
// work that already has a team and a shape, and inventing a project from here would mean inventing those too.
export function AddInitiativeProjectsButton({
  initiativeId,
  candidates,
}: {
  initiativeId: string
  // The workspace's projects that do not already name this goal (`projectCandidatesFor`). Empty = everything is
  // already in, and the control says so instead of opening an empty picker.
  candidates: { id: string; name: string }[]
}) {
  const t = useTranslations('initiativesPage')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [pending, startTransition] = useTransition()

  function submit() {
    if (selected.length === 0) return
    startTransition(async () => {
      const r = await addProjectsToInitiativeAction(initiativeId, selected)
      if (!r.ok) {
        toast.error(r.error ?? t('addProjectsError'))
        return
      }
      setOpen(false)
      setSelected([])
      toast.success(t('addProjectsDone', { count: r.changed }))
      router.refresh()
    })
  }

  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => setOpen(true)}
        disabled={candidates.length === 0}
        title={candidates.length === 0 ? t('addProjectsNone') : undefined}
      >
        <Plus className="size-3.5" />
        {t('addProjects')}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} className="max-w-lg">
        <form
          className="space-y-4 p-5"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <h2 className="text-[15px] font-[560] text-foreground">{t('addProjectsTitle')}</h2>
          <div className="space-y-1.5">
            <Label htmlFor="initiative-projects">{t('addProjectsLabel')}</Label>
            <MultiSelect
              id="initiative-projects"
              options={candidates.map((project) => ({
                value: project.id,
                label: project.name,
              }))}
              selected={selected}
              onChange={setSelected}
              placeholder={t('addProjectsPlaceholder')}
              emptyLabel={t('addProjectsNone')}
              removeLabel={(name) => t('addProjectsRemove', { name })}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              {t('cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={pending || selected.length === 0}>
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              {t('addProjectsSubmit')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  )
}
