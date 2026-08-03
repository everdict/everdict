'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { ISSUE_STATUSES, type IssueStatus } from '@/entities/issue'
import { WORKFLOW_STATE_COLORS, type WorkflowState, type WorkflowStateColor } from '@/entities/workflow-state'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Input } from '@/shared/ui/input'
import { cn } from '@/shared/lib/utils'

import {
  createWorkflowStateAction,
  deleteWorkflowStateAction,
  updateWorkflowStateAction,
} from '../api/manage-team'

// 라벨 칩과 같은 색 어휘 — 테마 토큰에 매핑되어 라이트/다크 양쪽에서 읽힌다(임의 hex 금지).
const DOT: Record<WorkflowStateColor, string> = {
  gray: 'bg-muted-foreground',
  purple: 'bg-[var(--chart-4)]',
  blue: 'bg-[var(--color-link)]',
  teal: 'bg-[var(--chart-3)]',
  green: 'bg-[var(--color-success)]',
  yellow: 'bg-[var(--color-warning)]',
  orange: 'bg-[var(--chart-2)]',
  red: 'bg-destructive',
  pink: 'bg-[var(--chart-5)]',
}

// `regressed` 는 컬럼이 될 수 없다 — 이슈는 해결이 무너져서 그리로 가지, 누가 카드를 끌어서 가지 않는다.
const MAPPABLE = ISSUE_STATUSES.filter((s) => s !== 'regressed')

export function WorkflowStatesEditor({
  teamId,
  states,
  canWrite,
}: {
  teamId: string
  states: WorkflowState[]
  canWrite: boolean
}) {
  const t = useTranslations('manageTeams')
  const tracker = useTranslations('tracker')
  const router = useRouter()
  const [error, setError] = useState<string>()
  const [name, setName] = useState('')
  const [status, setStatus] = useState<IssueStatus>('todo')
  const [color, setColor] = useState<WorkflowStateColor>('blue')
  const [pending, startTransition] = useTransition()

  function act(run: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(undefined)
    startTransition(async () => {
      const r = await run()
      if (!r.ok) {
        setError(r.error)
        return
      }
      after?.()
      router.refresh()
    })
  }

  // 순서 바꾸기는 두 컬럼의 position 을 맞바꾸는 것 — 보드의 순서가 곧 의미라, 화면에서만 움직이면 안 된다.
  function swap(index: number, delta: number) {
    const a = states[index]
    const b = states[index + delta]
    if (!a || !b) return
    act(async () => {
      const first = await updateWorkflowStateAction(teamId, a.id, { position: b.position })
      if (!first.ok) return first
      return updateWorkflowStateAction(teamId, b.id, { position: a.position })
    })
  }

  return (
    <div className="space-y-3">
      {error !== undefined && <Callout tone="danger">{error}</Callout>}
      <ul className="divide-y divide-border overflow-hidden rounded-lg border">
        {states.map((state, index) => (
          <li key={state.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
            <span className={cn('size-2.5 shrink-0 rounded-full', DOT[state.color])} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-[510] text-foreground">
              {state.name}
            </span>
            {/* 이 컬럼이 어느 정규 상태인지 — 이름은 사람이 읽고, 이 값은 코드가 읽는다. */}
            <span className="shrink-0 text-[11.5px] text-muted-foreground">
              {tracker(`issueStatus.${state.status}`)}
            </span>
            {canWrite && (
              <span className="flex shrink-0 items-center gap-1">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('stateMoveUp')}
                  disabled={pending || index === 0}
                  onClick={() => swap(index, -1)}
                >
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('stateMoveDown')}
                  disabled={pending || index === states.length - 1}
                  onClick={() => swap(index, 1)}
                >
                  <ArrowDown className="size-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('stateDelete')}
                  disabled={pending}
                  onClick={() => act(() => deleteWorkflowStateAction(teamId, state.id))}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>

      {canWrite && (
        <div className="@container flex flex-col gap-2 @md:flex-row">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('stateNamePlaceholder')}
            className="min-w-0 flex-1"
          />
          <Combobox
            value={status}
            onChange={(v) => setStatus(v as IssueStatus)}
            options={MAPPABLE.map((s) => ({ value: s, label: tracker(`issueStatus.${s}`) }))}
            className="w-44"
          />
          <Combobox
            value={color}
            onChange={(v) => setColor(v as WorkflowStateColor)}
            options={WORKFLOW_STATE_COLORS.map((c) => ({ value: c, label: c }))}
            className="w-32"
          />
          <Button
            size="sm"
            disabled={pending || name.trim() === ''}
            onClick={() =>
              act(
                () => createWorkflowStateAction(teamId, { name: name.trim(), status, color }),
                () => setName('')
              )
            }
          >
            <Plus className="size-3.5" />
            {t('stateAdd')}
          </Button>
        </div>
      )}
    </div>
  )
}
