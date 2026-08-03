'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { MediaDropZone, withBlockInsertion } from '@/features/attach-media'
import type { Issue } from '@/entities/issue'
import type { IssueLabel } from '@/entities/issue-label'
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
  // 워크스페이스 라벨 레지스트리 — 고를 대상이자 칩을 그리는 근거. 라벨은 이제 자유 문자열이 아니라 레코드다.
  labels: IssueLabel[]
  canWrite: boolean
  canAttach?: boolean
}) {
  const t = useTranslations('issuesPage')
  const router = useRouter()
  const [title, setTitle] = useState(issue.title)
  const [description, setDescription] = useState(issue.description ?? '')
  const [assignee, setAssignee] = useState(issue.assignee ?? '')
  const [projectId, setProjectId] = useState(issue.projectId ?? '')
  const [labelIds, setLabelIds] = useState(issue.labelIds)
  const [estimate, setEstimate] = useState(
    issue.estimate === undefined ? '' : String(issue.estimate)
  )
  const [dueDate, setDueDate] = useState(issue.dueDate ?? '')
  const [pending, startTransition] = useTransition()
  const descriptionRef = useRef<HTMLTextAreaElement>(null)

  // 올라간 첨부는 커서 자리에 들어간다. 현재 값은 상태가 아니라 텍스트영역에서 읽는다 — 파일을 여러 개 놓으면
  // 업로드가 하나씩 이어져, 그 사이 렌더에서 닫힌 상태 값은 이미 지난 값이기 때문이다.
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
      // 순서까지 포함해 비교한다 — 같은 집합이면 PATCH 를 보내지 않는다. 구분자는 이슈 id 에 나올 수 없는
      // 공백이면 충분하다(예전 코드는 여기에 리터럴 NUL 바이트를 넣어 파일 전체를 grep 에 안 잡히게 만들었다).
      ...(labelIds.join(' ') !== issue.labelIds.join(' ') ? { labelIds } : {}),
      // 빈 칸은 "비우기"(null)다 — 숫자 입력에서 지운 것과 손대지 않은 것을 구분해야 한다.
      ...(estimate !== (issue.estimate === undefined ? '' : String(issue.estimate))
        ? { estimate: estimate === '' ? null : Number(estimate) }
        : {}),
      ...(dueDate !== (issue.dueDate ?? '') ? { dueDate: dueDate === '' ? null : dueDate } : {}),
    }
    if (Object.keys(patch).length === 0) {
      onClose()
      return
    }
    startTransition(async () => {
      const r = await updateIssueAction(issue.id, patch)
      if (!r.ok) {
        toast.error(r.error ?? t('editError'))
        return
      }
      onClose()
      router.refresh()
    })
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
          {/* 재현 화면은 설명의 일부다 — 붙여넣거나 끌어다 놓으면 커서 자리에 첨부 문법이 들어간다. */}
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
