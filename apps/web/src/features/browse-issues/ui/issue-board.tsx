'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import {
  ResolveIssueDialog,
  setIssueStatusAction,
  updateIssueAction,
} from '@/features/manage-issue'
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  issueHref,
  IssuePriorityIcon,
  type IssueGroupBy,
  type IssueSummary,
} from '@/entities/issue'
import { IssueLabelChips } from '@/entities/issue-label'
import { memberNameOf } from '@/entities/member'
import { useRefresh } from '@/shared/lib/use-refresh'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import { Link } from '@/shared/ui/link'

import type { IssueDirectories } from '../model/directories'
import { IssueGroupLabel } from './issue-group-label'

export interface IssueBoardColumn {
  key: string | null
  count: number
  items: IssueSummary[]
  // 컬럼이 자기 몫보다 적게 들고 있을 때 — 보드는 훑는 화면이라 그룹 안 페이지네이션 대신 사실을 말한다.
  truncated: boolean
}

// 보드 — 컬럼이 곧 그룹이고, 카드를 끌어다 놓는 것이 그 축의 값을 바꾸는 것이다. 상태 축에서 완료 컬럼에
// 떨어뜨리면 해결 다이얼로그가 뜬다: 이슈를 닫는다는 건 "무엇이 그것을 증명했나"를 남기는 일이라, 드래그
// 한 번으로 그 기록을 건너뛰게 할 수 없다(목록의 상태 컨트롤과 정확히 같은 규칙).
//
// 사이클 축만 드래그가 없다: 이슈를 이터레이션에 넣고 빼는 표면이 제어 평면에 아직 없다. 끌리는 것처럼
// 보였다가 아무 일도 일어나지 않는 것보다, 처음부터 안 끌리는 편이 정직하다.
export function IssueBoard({
  workspace,
  groupBy,
  columns,
  directories,
  canWrite,
}: {
  workspace: string
  groupBy: IssueGroupBy
  columns: IssueBoardColumn[]
  directories: IssueDirectories
  canWrite: boolean
}) {
  const t = useTranslations('issuesPage')
  const refresh = useRefresh()
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  // 완료 컬럼에 떨어진 카드 — 해결 정보를 받은 뒤에야 실제로 옮긴다.
  const [resolving, setResolving] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const draggable = canWrite

  function move(
    id: string,
    key: string | null,
    resolution?: { scorecardId?: string; note?: string }
  ) {
    void (async () => {
      setPending(true)
      try {
        const result = await applyGroupMove(groupBy, id, key, resolution)
        if (!result.ok) {
          toast.error(result.error ?? t('boardMoveError'))
          return
        }
        setResolving(null)
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  function drop(key: string | null) {
    const id = dragging
    setDragging(null)
    setOver(null)
    if (id === null || !draggable) return
    // 완료는 해결을 남긴다 — 어느 스코어카드가 증명했는지 없이 닫히는 이슈가 트래커의 요점을 지운다.
    if (groupBy === 'status' && key === 'done') {
      setResolving(id)
      return
    }
    move(id, key)
  }

  return (
    <>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {columns.map((column) => {
          const columnId = column.key ?? '\u0000unset'
          return (
            <div
              key={columnId}
              onDragOver={(e) => {
                if (!draggable || dragging === null) return
                e.preventDefault() // 기본값은 "여기 못 놓음"이다 — 막아야 드롭이 열린다
                setOver(columnId)
              }}
              onDragLeave={() => setOver((prev) => (prev === columnId ? null : prev))}
              onDrop={() => drop(column.key)}
              className={cn(
                'flex w-[280px] shrink-0 flex-col gap-2 rounded-lg border border-border bg-card/40 p-2 transition-colors',
                over === columnId && 'border-primary/50 bg-primary/5'
              )}
            >
              <div className="flex items-center gap-1.5 px-1 text-[12.5px] font-[510] text-foreground">
                <IssueGroupLabel
                  groupBy={groupBy}
                  groupKey={column.key}
                  directories={directories}
                />
                <span className="ml-auto shrink-0 rounded-full bg-secondary px-1.5 text-[11px] tabular-nums text-muted-foreground">
                  {column.count}
                </span>
              </div>
              {column.items.map((issue) => (
                <article
                  key={issue.id}
                  draggable={draggable}
                  onDragStart={() => setDragging(issue.id)}
                  onDragEnd={() => {
                    setDragging(null)
                    setOver(null)
                  }}
                  className={cn(
                    'rounded-lg border bg-card p-2.5 shadow-raise transition-opacity',
                    draggable && 'cursor-grab active:cursor-grabbing',
                    dragging === issue.id && 'opacity-40',
                    issue.status === 'regressed' && 'border-destructive/40 bg-destructive/5'
                  )}
                >
                  <Link href={issueHref(workspace, issue.identifier)} className="block">
                    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <IssuePriorityIcon priority={issue.priority} className="[&_svg]:size-3" />
                      <span className="font-mono">{issue.identifier}</span>
                    </p>
                    <p className="mt-1 line-clamp-3 text-[12.5px] text-foreground">{issue.title}</p>
                  </Link>
                  <div className="mt-2 flex items-center gap-1.5">
                    <IssueLabelChips labelIds={issue.labelIds} directory={directories.labels} />
                    {issue.assignee !== undefined && (
                      <span
                        className="ml-auto shrink-0"
                        title={memberNameOf(directories.actors, issue.assignee)}
                      >
                        <Avatar
                          name={memberNameOf(directories.actors, issue.assignee)}
                          size="sm"
                          {...(directories.actors[issue.assignee]?.avatarUrl !== undefined
                            ? { url: directories.actors[issue.assignee].avatarUrl }
                            : {})}
                        />
                      </span>
                    )}
                  </div>
                </article>
              ))}
              {column.items.length === 0 && (
                <p className="px-1 py-3 text-center text-[11.5px] text-faint">
                  {t('boardColumnEmpty')}
                </p>
              )}
              {/* 조용히 자르지 않는다 — 컬럼이 몇 개를 안 그리고 있는지 말하고, 전부는 목록에서 본다. */}
              {column.truncated && (
                <p className="px-1 text-[11.5px] text-muted-foreground">
                  {t('boardColumnMore', { count: Math.max(column.count - column.items.length, 0) })}
                </p>
              )}
            </div>
          )
        })}
        {pending && (
          <span className="sr-only" role="status">
            <Loader2 className="size-3 animate-spin" />
          </span>
        )}
      </div>
      <ResolveIssueDialog
        open={resolving !== null}
        onClose={() => setResolving(null)}
        onResolve={(resolution) => resolving !== null && move(resolving, 'done', resolution)}
        pending={pending}
        scorecards={[]}
      />
    </>
  )
}

// 어느 축의 보드냐가 곧 어떤 변경이냐다. 상태만 워크플로 전이(`setIssueStatus`)이고 나머지는 내용 편집 —
// 제어 평면이 그렇게 나뉘어 있고, 여기서 합치면 이력에 "상태가 바뀌었다"는 잘못된 줄이 남는다.
async function applyGroupMove(
  groupBy: IssueGroupBy,
  id: string,
  key: string | null,
  resolution?: { scorecardId?: string; note?: string }
): Promise<{ ok: boolean; error?: string }> {
  if (groupBy === 'status') {
    const status = ISSUE_STATUSES.find((s) => s === key)
    if (status === undefined) return { ok: false }
    return setIssueStatusAction(id, status, resolution)
  }
  if (groupBy === 'priority') {
    const priority = ISSUE_PRIORITIES.find((p) => p === key)
    if (priority === undefined) return { ok: false }
    return updateIssueAction(id, { priority })
  }
  if (groupBy === 'assignee') return updateIssueAction(id, { assignee: key })
  if (groupBy === 'project') return updateIssueAction(id, { projectId: key })
  return { ok: false }
}
