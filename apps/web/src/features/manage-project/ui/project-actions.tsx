'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { Project } from '@/entities/project'
import { TeamKeyBadge } from '@/entities/team'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Input, Label, Textarea } from '@/shared/ui/input'
import { MultiSelect } from '@/shared/ui/multi-select'

import { deleteProjectAction, updateProjectAction } from '../api/projects'

// 목록 필드는 순서까지 그대로일 때만 "안 바뀜"이다 — 서버는 받은 목록으로 통째로 대체하므로, 바뀐 것이
// 없는데 보내면 이력에 빈 변경이 남는다.
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
  teams,
}: {
  workspace: string
  project: Project
  initiatives: { id: string; name: string }[]
  teams: { id: string; key: string; name: string }[]
}) {
  const t = useTranslations('projectsPage')
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')
  const [initiativeIds, setInitiativeIds] = useState<string[]>(project.initiativeIds)
  const [teamIds, setTeamIds] = useState<string[]>(project.teamIds)
  const [targetDate, setTargetDate] = useState(project.targetDate ?? '')
  const [pending, startTransition] = useTransition()

  function save() {
    const patch = {
      ...(name.trim() !== project.name && name.trim() !== '' ? { name: name.trim() } : {}),
      ...(cleared(description, project.description) !== undefined
        ? { description: cleared(description, project.description) }
        : {}),
      ...(sameIds(initiativeIds, project.initiativeIds) ? {} : { initiativeIds }),
      ...(sameIds(teamIds, project.teamIds) ? {} : { teamIds }),
      ...(targetDate !== (project.targetDate ?? '')
        ? { targetDate: targetDate === '' ? null : targetDate }
        : {}),
    }
    if (Object.keys(patch).length === 0) {
      setEditing(false)
      return
    }
    startTransition(async () => {
      const r = await updateProjectAction(project.id, patch)
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
      const r = await deleteProjectAction(project.id)
      if (!r.ok) {
        toast.error(r.error ?? t('deleteError'))
        return
      }
      setConfirming(false)
      router.push(`/${workspace}/projects`)
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
              <Label htmlFor="edit-project-teams">{t('fieldTeams')}</Label>
              <MultiSelect
                id="edit-project-teams"
                selected={teamIds}
                onChange={setTeamIds}
                // 마지막 한 팀은 뺄 수 없다 — 프로젝트는 언제나 누군가의 일이고, 팀을 다 빼면 어느
                // 사이드바에도 없는 프로젝트가 된다(제어 평면도 400 으로 거부한다).
                minSelected={1}
                placeholder={t('fieldTeamsPlaceholder')}
                emptyLabel={t('fieldTeamsEmpty')}
                removeLabel={(teamName) => t('fieldTeamRemove', { name: teamName })}
                options={teams.map((x) => ({
                  value: x.id,
                  label: x.name,
                  badge: <TeamKeyBadge teamKey={x.key} />,
                }))}
              />
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
