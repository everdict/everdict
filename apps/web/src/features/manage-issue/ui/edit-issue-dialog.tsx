'use client'

import { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { MediaDropZone, withBlockInsertion } from '@/features/attach-media'
import type { Issue } from '@/entities/issue'
import type { IssueLabel } from '@/entities/issue-label'
import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label, Textarea } from '@/shared/ui/input'

import { updateIssueAction } from '../api/issues'
import { IssueLabelPicker } from './issue-label-picker'

// PATCH semantics: `null` CLEARS an optional field (unassign, detach from a project), `undefined` leaves it
// alone — so an emptied input has to travel as an explicit null, never as ''.
function cleared(next: string, previous: string | undefined): string | null | undefined {
  const trimmed = next.trim()
  if (trimmed === (previous ?? '')) return undefined
  return trimmed === '' ? null : trimmed
}

export function EditIssueDialog({
  issue,
  open,
  onClose,
  projects,
  labels,
  canWrite,
  canAttach = false,
}: {
  issue: Issue
  open: boolean
  onClose: () => void
  projects: { id: string; name: string }[]
  // The workspace label registry — both what can be picked and the basis for drawing the chips. A label is a RECORD now, not a free string.
  labels: IssueLabel[]
  canWrite: boolean
  canAttach?: boolean
}) {
  const t = useTranslations('issuesPage')
  const refresh = useRefresh()
  const [title, setTitle] = useState(issue.title)
  const [description, setDescription] = useState(issue.description ?? '')
  const [assignee, setAssignee] = useState(issue.assignee ?? '')
  const [projectId, setProjectId] = useState(issue.projectId ?? '')
  const [labelIds, setLabelIds] = useState(issue.labelIds)
  const [estimate, setEstimate] = useState(
    issue.estimate === undefined ? '' : String(issue.estimate)
  )
  const [dueDate, setDueDate] = useState(issue.dueDate ?? '')
  const [pending, setPending] = useState(false)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)

  // An uploaded attachment goes in at the caret. The current value is read from the TEXTAREA rather than from state — dropping several files
  // chains the uploads one after another, and the state value closed over in between renders is already stale.
  function insertAttachment(snippet: string) {
    const ta = descriptionRef.current
    const current = ta?.value ?? description
    const start = ta?.selectionStart ?? current.length
    const end = ta?.selectionEnd ?? current.length
    const next = withBlockInsertion(current, start, end, snippet)
    setDescription(next.value)
    queueMicrotask(() => {
      descriptionRef.current?.focus()
      descriptionRef.current?.setSelectionRange(next.caret, next.caret)
    })
  }

  function submit() {
    const patch = {
      ...(title.trim() !== issue.title && title.trim() !== '' ? { title: title.trim() } : {}),
      ...(cleared(description, issue.description) !== undefined
        ? { description: cleared(description, issue.description) }
        : {}),
      ...(cleared(assignee, issue.assignee) !== undefined
        ? { assignee: cleared(assignee, issue.assignee) }
        : {}),
      ...(projectId !== (issue.projectId ?? '')
        ? { projectId: projectId === '' ? null : projectId }
        : {}),
      // Compared INCLUDING order — an identical set sends no PATCH. A separator only has to be something that cannot appear in an issue id, and a
      // space is enough (the old code put a literal NUL byte here, which made the whole file invisible to grep).
      ...(labelIds.join(' ') !== issue.labelIds.join(' ') ? { labelIds } : {}),
      // An empty box means "clear" (null) — cleared and untouched have to be distinguishable on a number input.
      ...(estimate !== (issue.estimate === undefined ? '' : String(issue.estimate))
        ? { estimate: estimate === '' ? null : Number(estimate) }
        : {}),
      ...(dueDate !== (issue.dueDate ?? '') ? { dueDate: dueDate === '' ? null : dueDate } : {}),
    }
    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }
    void (async () => {
      setPending(true)
      try {
        const r = await updateIssueAction(issue.id, patch)
        if (!r.ok) {
          toast.error(r.error ?? t('editError'))
          return
        }
        onClose()
        refresh()
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
        <h2 className="text-[15px] font-[560] text-foreground">{t('editTitle')}</h2>
        <div className="space-y-1.5">
          <Label htmlFor="edit-issue-title">{t('fieldTitle')}</Label>
          <Input id="edit-issue-title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="edit-issue-description">{t('fieldDescription')}</Label>
          {/* A reproduction screenshot is part of the description — pasted or dropped, the attachment syntax goes in at the caret. */}
          <MediaDropZone onInsert={insertAttachment} disabled={!canAttach}>
            <Textarea
              id="edit-issue-description"
              ref={descriptionRef}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </MediaDropZone>
        </div>
        <div className="grid gap-3 @md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="edit-issue-assignee">{t('fieldAssignee')}</Label>
            <Input
              id="edit-issue-assignee"
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              placeholder={t('fieldAssigneeNone')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-issue-project">{t('fieldProject')}</Label>
            <Combobox
              id="edit-issue-project"
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
        <div className="grid gap-3 @md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="edit-issue-estimate">{t('fieldEstimate')}</Label>
            <Input
              id="edit-issue-estimate"
              type="number"
              min={0}
              max={1000}
              value={estimate}
              onChange={(e) => setEstimate(e.target.value)}
              placeholder={t('fieldEstimateNone')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="edit-issue-due">{t('fieldDueDate')}</Label>
            <Input
              id="edit-issue-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>{t('fieldLabels')}</Label>
          <IssueLabelPicker
            labels={labels}
            selected={labelIds}
            onChange={setLabelIds}
            canCreate={canWrite}
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : t('save')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
