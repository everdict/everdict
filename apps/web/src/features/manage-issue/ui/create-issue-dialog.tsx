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
  // 이 팀의 열린 이터레이션. 팀 스코프 화면에서만 채워진다 — 여러 팀이 섞인 목록에서는 "어느 팀의 3번인가"에
  // 답할 수 없고, 이슈는 자기 팀의 사이클에만 들어간다.
  cycles?: { id: string; name: string }[]
  // 팀이 하나뿐이면 고를 게 없다 — 필드를 숨기고 서버가 기본팀으로 보낸다.
  teams?: { id: string; key: string; name: string }[]
  // 하위 이슈로 접수할 부모. 있으면 제목이 "하위 이슈 추가"로 읽히고, 만든 뒤에도 부모 화면에 남는다 —
  // 쪼개는 중에 매번 자식 화면으로 튕겨 나가면 다음 조각을 이어서 적을 수 없다.
  parentId?: string
}

// 새 이슈 폼 그 자체. 트리거에서 떼어 낸 이유는 하위 이슈 때문이다 — "하위 이슈 추가"는 버튼이 아니라
// ⋯ 메뉴의 한 줄이어야 하고(리니어와 같다), 메뉴 항목이 버튼을 렌더할 수는 없다. 여는 쪽이 상태를 들고
// 이 다이얼로그는 열림 여부만 받는다.
export function CreateIssueDialog({
  workspace,
  projects,
  cycles = [],
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
  const [cycleId, setCycleId] = useState('')
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
        setCycleId('')
        setPriority('none')
        setEstimate('')
        setDueDate('')
        // 하위 이슈를 만들 때는 부모 화면에 머문다(다음 조각을 이어서 적는 흐름) — 그 외에는 만든 이슈로 간다.
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
          {/* 사이클을 쓰는 팀에서만. 접수하면서 바로 이번 주기에 넣는 것은 리니어의 기본 동선이고,
              없으면 만들고 나서 상세를 다시 열어야 한다. */}
          {cycles.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="issue-cycle">{t('fieldCycle')}</Label>
              <Combobox
                id="issue-cycle"
                value={cycleId}
                onChange={setCycleId}
                placeholder={t('fieldCycleNone')}
                options={[
                  { value: '', label: t('fieldCycleNone') },
                  ...cycles.map((c) => ({ value: c.id, label: c.name })),
                ]}
              />
            </div>
          )}
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
