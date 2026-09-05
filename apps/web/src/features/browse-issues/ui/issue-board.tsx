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
  // When a column holds fewer than its share — a board is a screen you SWEEP, so instead of paginating inside a group it states the fact.
  truncated: boolean
}

// The board — a column IS a group, and dragging a card changes that axis' value. Dropping onto the done column on the status axis raises the
// resolution dialog: closing an issue means recording "what proved it", so one drag cannot be allowed to skip that record
// (exactly the same rule as the list's status control).
//
// Only the cycle axis has no dragging: the control plane has no surface yet for adding an issue to and removing it from an iteration. Not
// being draggable from the start is more honest than looking draggable and then doing nothing.
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
  // A card dropped on the done column — it is only actually moved once the resolution details have been given.
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
    // Done leaves a RESOLUTION — an issue closing with no record of which scorecard proved it erases the point of the tracker.
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
                e.preventDefault() // the default is "cannot drop here" — preventing it is what opens the drop
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
              {/* Nothing is truncated silently — the column says how many it is not drawing, and everything is seen in the list. */}
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

// Which axis the board is on IS which kind of change it makes. Only status is a workflow transition (`setIssueStatus`); the rest are content
// edits — the control plane is split that way, and merging them here would leave a false "the status changed" line in the history.
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
