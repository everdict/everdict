'use client'

import { useState } from 'react'
import { useRefresh } from '@/shared/lib/use-refresh'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { ISSUE_PRIORITIES, issueHref, type IssuePriority, type IssueStatus } from '@/entities/issue'
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

export interface CreateIssueDialogProps {
  workspace: string
  projects: { id: string; name: string }[]
  // This team's open iterations. Filled only on a team-scoped screen — on a list mixing several teams there is no answer to "whose cycle 3 is
  // this", and an issue only enters its own team's cycles.
  // With only one team there is nothing to pick — the field hides and the server sends it to the default team.
  teams?: { id: string; key: string; name: string }[]
  // The parent to file this under as a sub-issue. Present, the title reads "add sub-issue" and it STAYS on the parent screen after creation —
  // being bounced to the child screen every time makes it impossible to keep writing the next piece while splitting work up.
  parentId?: string
}

// The new-issue form itself. It is separated from the trigger because of sub-issues — "add sub-issue" has to be a row in the ⋯ menu rather than
// a button (as in Linear), and a menu item cannot render a button. The OPENER holds the state and this dialog receives only whether it is open.
export function CreateIssueDialog({
  workspace,
  projects,
  parentId,
  open,
  onClose,
}: CreateIssueDialogProps & { open: boolean; onClose: () => void }) {
  const t = useTranslations('issuesPage')
  const tracker = useTranslations('tracker')
  const router = useRouter()
  const refresh = useRefresh()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<IssueStatus>('backlog')
  const [projectId, setProjectId] = useState('')
  const [priority, setPriority] = useState<IssuePriority>('none')
  const [estimate, setEstimate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [pending, setPending] = useState(false)

  function submit() {
    const trimmed = title.trim()
    if (trimmed.length === 0) return
    void (async () => {
      setPending(true)
      try {
        const r = await createIssueAction({
          title: trimmed,
          ...(description.trim() ? { description: description.trim() } : {}),
          status,
          ...(projectId ? { projectId } : {}),
          ...(priority !== 'none' ? { priority } : {}),
          ...(estimate ? { estimate: Number(estimate) } : {}),
          ...(dueDate ? { dueDate } : {}),
          ...(parentId ? { parentId } : {}),
        })
        if (!r.ok || !r.issue) {
          toast.error(r.error ?? t('createError'))
          return
        }
        onClose()
        setTitle('')
        setDescription('')
        setProjectId('')
        setPriority('none')
        setEstimate('')
        setDueDate('')
        // Creating a sub-issue stays on the parent screen (the flow of writing the next piece) — everything else goes to the issue just created.
        if (parentId !== undefined) refresh()
        else router.push(issueHref(workspace, r.issue.identifier, r.issue.title))
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <form
        className="@container space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <h2 className="text-[15px] font-[560] text-foreground">
          {parentId === undefined ? t('createTitle') : t('subIssueAdd')}
        </h2>
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
            <Label htmlFor="issue-priority">{t('fieldPriority')}</Label>
            <Combobox
              id="issue-priority"
              value={priority}
              onChange={(v) => setPriority(v as IssuePriority)}
              options={ISSUE_PRIORITIES.map((p) => ({
                value: p,
                label: tracker(`issuePriority.${p}`),
              }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="issue-estimate">{t('fieldEstimate')}</Label>
            <Input
              id="issue-estimate"
              type="number"
              min={0}
              max={1000}
              value={estimate}
              onChange={(e) => setEstimate(e.target.value)}
              placeholder={t('fieldEstimateNone')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="issue-due">{t('fieldDueDate')}</Label>
            <Input
              id="issue-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
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
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={pending || title.trim().length === 0}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : t('create')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
