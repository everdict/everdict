'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { TeamKeyBadge } from '@/entities/team'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { MultiSelect } from '@/shared/ui/multi-select'

import { createProjectAction } from '../api/projects'

export function CreateProjectButton({
  workspace,
  initiatives,
  teams,
  defaultTeamIds,
}: {
  workspace: string
  initiatives: { id: string; name: string }[]
  // 프로젝트는 여러 팀이 함께 한다. 아무 팀도 고르지 않으면 제어 평면이 워크스페이스 기본 팀에 올려 준다.
  teams: { id: string; key: string; name: string }[]
  // 팀 아래(`/teams/ENG/projects`)에서 열었으면 그 팀이 미리 골라져 있다 — 방금 보고 있던 목록에 나타나지
  // 않을 곳에 프로젝트를 만드는 일이 없도록. 여전히 바꿀 수 있다(프로젝트는 여러 팀의 것일 수 있다).
  defaultTeamIds?: string[]
}) {
  const t = useTranslations('projectsPage')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [initiativeIds, setInitiativeIds] = useState<string[]>([])
  const [teamIds, setTeamIds] = useState<string[]>(defaultTeamIds ?? [])
  const [targetDate, setTargetDate] = useState('')
  const [pending, startTransition] = useTransition()

  function submit() {
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    startTransition(async () => {
      const r = await createProjectAction({
        name: trimmed,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(initiativeIds.length > 0 ? { initiativeIds } : {}),
        ...(teamIds.length > 0 ? { teamIds } : {}),
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
      setTeamIds(defaultTeamIds ?? [])
      setTargetDate('')
      router.push(`/${workspace}/projects/${encodeURIComponent(r.project.id)}`)
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
          <div className="grid gap-3 @md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="project-teams">{t('fieldTeams')}</Label>
              <MultiSelect
                id="project-teams"
                selected={teamIds}
                onChange={setTeamIds}
                placeholder={t('fieldTeamsPlaceholder')}
                emptyLabel={t('fieldTeamsEmpty')}
                removeLabel={(name) => t('fieldTeamRemove', { name })}
                options={teams.map((x) => ({
                  value: x.id,
                  label: x.name,
                  badge: <TeamKeyBadge teamKey={x.key} />,
                }))}
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
