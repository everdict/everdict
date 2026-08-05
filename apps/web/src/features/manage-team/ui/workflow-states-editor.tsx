'use client'

import { useState } from 'react'
import { ArrowDown, ArrowUp, Check, Plus, Trash2, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { IssueStatusIcon, type IssueStatus } from '@/entities/issue'
import { LabelColorPicker, LabelDot } from '@/entities/issue-label'
import {
  WORKFLOW_COLUMN_STATUSES,
  type WorkflowState,
  type WorkflowStateColor,
} from '@/entities/workflow-state'
import { useRefresh } from '@/shared/lib/use-refresh'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { DropdownMenu, useDropdownClose } from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'

import {
  createWorkflowStateAction,
  deleteWorkflowStateAction,
  updateWorkflowStateAction,
} from '../api/manage-team'

// 새 상태가 처음 입는 색 — 그 자리에 이미 있는 컬럼이 없을 때의 기본값(제어 평면이 팀에 심어 주는 기본 보드와
// 같은 짝이라, 새로 만든 컬럼이 옆 컬럼과 같은 계열로 시작한다).
const DEFAULT_COLOR: Record<IssueStatus, WorkflowStateColor> = {
  backlog: 'gray',
  todo: 'blue',
  in_progress: 'yellow',
  in_review: 'purple',
  done: 'green',
  cancelled: 'gray',
  regressed: 'red',
}

// 팀의 보드 — 정규 상태마다 그 팀이 붙인 이름들.
//
// **정규 상태로 묶어서 보여주는 것이 이 화면의 전부다.** 예전에는 컬럼이 한 줄로 쭉 늘어서고 각 행의 오른쪽에
// 정규 상태가 회색 글씨로 적혀 있었는데, 그러면 "이 이름이 무엇의 다른 이름인가"를 행마다 다시 읽어야 하고
// 기본 보드에서는 같은 말이 두 번 적힌다(Backlog · Backlog). 그리고 새 컬럼을 만드는 폼이 목록 바깥 루트에
// 떠 있어서, 만들면서 정규 상태를 콤보박스로 다시 골라야 했다 — 어디에 만드는지를 화면이 이미 알고 있는데도.
//
// 그래서 리니어처럼 자리(정규 상태)가 머리글이 되고, 추가 버튼은 **그 자리의 머리글 안**에 있다: 어디에
// 만드는지가 곧 무엇으로 만드는지라, 고를 것이 하나 줄어든다.
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
  const refresh = useRefresh()
  const [error, setError] = useState<string>()
  // 지금 새 컬럼을 받고 있는 자리. 한 번에 한 곳만 열린다 — 폼이 그 자리 안에 있으므로 여러 개가 동시에 열리면
  // 어디에 만드는 중인지가 다시 흐려진다.
  const [adding, setAdding] = useState<IssueStatus>()
  const [draftName, setDraftName] = useState('')
  const [draftColor, setDraftColor] = useState<WorkflowStateColor>('gray')
  const [pending, setPending] = useState(false)

  function act(run: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(undefined)
    void (async () => {
      setPending(true)
      try {
        const r = await run()
        if (!r.ok) {
          setError(r.error)
          return
        }
        after?.()
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  // 이름 바꾸기·색 바꾸기는 즉시 적용된다(저장 버튼이 없다). 실패는 토스트로 알리고 서버 값으로 되돌린다 —
  // 컬럼 이름은 폼이 아니라 그 자리에 붙은 이름표라, 눌러 두고 잊어버리는 저장 버튼이 있으면 안 된다.
  function applyNow(run: () => Promise<{ ok: boolean; error?: string }>) {
    void (async () => {
      setPending(true)
      try {
        const r = await run()
        if (!r.ok) toast.error(r.error ?? t('stateSaveError'))
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  function openAdd(status: IssueStatus, siblings: WorkflowState[]) {
    setError(undefined)
    setAdding(status)
    setDraftName('')
    setDraftColor(siblings[siblings.length - 1]?.color ?? DEFAULT_COLOR[status])
  }

  function submitAdd(status: IssueStatus) {
    const name = draftName.trim()
    if (name === '') return
    act(
      () => createWorkflowStateAction(teamId, { name, status, color: draftColor }),
      () => {
        setAdding(undefined)
        setDraftName('')
      }
    )
  }

  // 순서 바꾸기는 두 컬럼의 position 을 맞바꾸는 것 — 보드의 순서가 곧 의미라, 화면에서만 움직이면 안 된다.
  // 같은 자리 안에서만 움직인다: `완료` 를 `백로그` 위로 올리는 것은 순서가 아니라 오독이다.
  function swap(rows: WorkflowState[], index: number, delta: number) {
    const a = rows[index]
    const b = rows[index + delta]
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
      <div className="overflow-hidden rounded-lg border bg-card shadow-raise">
        {WORKFLOW_COLUMN_STATUSES.map((status, groupIndex) => {
          const rows = states
            .filter((state) => state.status === status)
            .sort((a, b) => a.position - b.position)
          return (
            <section
              key={status}
              className={cn(groupIndex > 0 && 'border-t border-border/70')}
              aria-label={tracker(`issueStatus.${status}`)}
            >
              {/* 자리 = 정규 상태. 이 머리글이 "이 아래 이름들은 무엇의 다른 이름인가"에 한 번에 답한다. */}
              <header className="flex h-9 items-center gap-2 bg-muted/25 px-3">
                <IssueStatusIcon status={status} className="[&_svg]:size-3.5" />
                <h3 className="text-[12px] font-[510] text-foreground">
                  {tracker(`issueStatus.${status}`)}
                </h3>
                <span className="text-[11px] tabular-nums text-faint">{rows.length}</span>
                {canWrite && (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    className="ml-auto"
                    aria-label={t('stateAddTo', { status: tracker(`issueStatus.${status}`) })}
                    title={t('stateAddTo', { status: tracker(`issueStatus.${status}`) })}
                    disabled={pending}
                    onClick={() => openAdd(status, rows)}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                )}
              </header>

              <ul>
                {rows.map((state, index) => (
                  <li
                    key={state.id}
                    className="group flex h-10 items-center gap-2 px-3 pl-8 transition-colors hover:bg-accent/40"
                  >
                    <ColorControl
                      color={state.color}
                      canWrite={canWrite}
                      disabled={pending}
                      onChange={(color) =>
                        applyNow(() => updateWorkflowStateAction(teamId, state.id, { color }))
                      }
                    />
                    {canWrite ? (
                      // 서버가 이름을 되돌려 주면 다시 마운트되도록 키에 이름을 넣는다 — 로컬 상태로 들고
                      // 있으면 거절당한 이름이 화면에만 남는다.
                      <input
                        key={`${state.id}:${state.name}`}
                        defaultValue={state.name}
                        aria-label={t('stateNameLabel')}
                        disabled={pending}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur()
                          if (e.key === 'Escape') {
                            e.currentTarget.value = state.name
                            e.currentTarget.blur()
                          }
                        }}
                        onBlur={(e) => {
                          const name = e.currentTarget.value.trim()
                          if (name === '' || name === state.name) {
                            e.currentTarget.value = state.name
                            return
                          }
                          applyNow(() => updateWorkflowStateAction(teamId, state.id, { name }))
                        }}
                        className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[13px] font-[510] text-foreground outline-none transition-colors hover:border-border focus:border-primary focus:bg-card disabled:opacity-50"
                      />
                    ) : (
                      <span className="min-w-0 flex-1 truncate px-1.5 text-[13px] font-[510] text-foreground">
                        {state.name}
                      </span>
                    )}
                    {canWrite && (
                      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        {/* 한 자리에 이름이 하나뿐이면 순서라는 것이 없다 — 그때는 화살표도 없다. */}
                        {rows.length > 1 && (
                          <>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={t('stateMoveUp')}
                              disabled={pending || index === 0}
                              onClick={() => swap(rows, index, -1)}
                            >
                              <ArrowUp className="size-3.5" />
                            </Button>
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              aria-label={t('stateMoveDown')}
                              disabled={pending || index === rows.length - 1}
                              onClick={() => swap(rows, index, 1)}
                            >
                              <ArrowDown className="size-3.5" />
                            </Button>
                          </>
                        )}
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

                {adding === status && (
                  <li className="flex h-11 items-center gap-2 bg-accent/30 px-3 pl-8">
                    <ColorControl
                      color={draftColor}
                      canWrite
                      disabled={pending}
                      onChange={setDraftColor}
                    />
                    <Input
                      autoFocus
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      placeholder={t('stateNamePlaceholder')}
                      aria-label={t('stateNameLabel')}
                      disabled={pending}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitAdd(status)
                        if (e.key === 'Escape') setAdding(undefined)
                      }}
                      className="h-7 min-w-0 flex-1"
                    />
                    <Button
                      size="icon-sm"
                      aria-label={t('add')}
                      disabled={pending || draftName.trim() === ''}
                      onClick={() => submitAdd(status)}
                    >
                      <Check className="size-3.5" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t('cancel')}
                      disabled={pending}
                      onClick={() => setAdding(undefined)}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </li>
                )}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}

// 색 고르기 — 라벨과 **같은 팔레트, 같은 선택기**다(entities/issue-label). 상태 색과 라벨 색은 같은 아홉
// 가지 닫힌 어휘이고, 고르는 물건이 둘이면 언젠가 한쪽만 손본다.
function ColorControl({
  color,
  canWrite,
  disabled,
  onChange,
}: {
  color: WorkflowStateColor
  canWrite: boolean
  disabled?: boolean
  onChange: (color: WorkflowStateColor) => void
}) {
  const t = useTranslations('manageTeams')
  if (!canWrite) return <LabelDot color={color} className="size-2.5" />

  return (
    <DropdownMenu
      className="shrink-0"
      contentClassName="min-w-0 p-2"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={t('stateColorLabel')}
          title={t('stateColorLabel')}
          disabled={disabled}
          className="flex size-5 items-center justify-center rounded-md transition-colors hover:bg-accent disabled:opacity-50"
        >
          <LabelDot color={color} className="size-2.5" />
        </button>
      )}
    >
      <ColorChoices selected={color} onSelect={onChange} />
    </DropdownMenu>
  )
}

// 고르면 닫힌다 — 색은 한 번에 하나이므로 메뉴를 열어 둘 이유가 없다.
function ColorChoices({
  selected,
  onSelect,
}: {
  selected: WorkflowStateColor
  onSelect: (color: WorkflowStateColor) => void
}) {
  const t = useTranslations('manageTeams')
  const close = useDropdownClose()
  return (
    <LabelColorPicker
      size="sm"
      ariaLabel={t('stateColorLabel')}
      value={selected}
      onChange={(next) => {
        onSelect(next)
        close()
      }}
    />
  )
}
