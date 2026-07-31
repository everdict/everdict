'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { IssueStatus } from '@/entities/issue'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label, Textarea } from '@/shared/ui/input'

import { createIssueAction } from '../api/issues'

// `done` and `regressed` are unreachable at creation by contract: closing records HOW it was evaluated, and a
// regression only means anything as the fall from a resolution.
const CREATABLE_STATUSES: IssueStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'cancelled',
]

export function CreateIssueButton({
  workspace,
  projects,
}: {
  workspace: string
  projects: { id: string; name: string }[]
}) {
  const t = useTranslations('issuesPage')
  const tracker = useTranslations('tracker')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<IssueStatus>('backlog')
  const [projectId, setProjectId] = useState('')
  const [pending, startTransition] = useTransition()

  function submit() {
    const trimmed = title.trim()
    if (trimmed.length === 0) return
    startTransition(async () => {
      const r = await createIssueAction({
        title: trimmed,
        ...(description.trim() ? { description: description.trim() } : {}),
        status,
        ...(projectId ? { projectId } : {}),
      })
      if (!r.ok || !r.issue) {
        toast.error(r.error ?? t('createError'))
        return
      }
      setOpen(false)
      setTitle('')
      setDescription('')
      setProjectId('')
      router.push(`/${workspace}/issues/${encodeURIComponent(r.issue.id)}`)
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
            <Label htmlFor="issue-title">{t('fieldTitle')}</Label>
            <Input
              id="issue-title"
              value={title}
              autoFocus
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('fieldTitlePlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="issue-description">{t('fieldDescription')}</Label>
            <Textarea
              id="issue-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t('fieldDescriptionPlaceholder')}
            />
          </div>
          <div className="grid gap-3 @md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="issue-status">{t('fieldStatus')}</Label>
              <Combobox
                id="issue-status"
                value={status}
                onChange={(v) => setStatus(v as IssueStatus)}
                options={CREATABLE_STATUSES.map((s) => ({
                  value: s,
                  label: tracker(`issueStatus.${s}`),
                }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="issue-project">{t('fieldProject')}</Label>
              <Combobox
                id="issue-project"
                value={projectId}
                onChange={setProjectId}
                placeholder={t('fieldProjectNone')}
                options={[
                  { value: '', label: t('fieldProjectNone') },
                  ...projects.map((p) => ({ value: p.id, label: p.name })),
                ]}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={pending || title.trim().length === 0}>
              {pending ? <Loader2 className="size-3.5 animate-spin" /> : t('create')}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  )
}
