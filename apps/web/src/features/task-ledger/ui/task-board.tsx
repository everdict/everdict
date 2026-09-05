'use client'

import { useCallback, useMemo, useState } from 'react'
import {
  Bot,
  Check,
  CircleDashed,
  Loader2,
  MoreHorizontal,
  Play,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { AgentTask, AgentTaskStatus } from '@/entities/agent-task'
import { fmtTimeAgo } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input } from '@/shared/ui/input'

import { createTaskAction, deleteTaskAction, updateTaskAction } from '../api/tasks'

// The task ledger board — the workspace's shared coordination work (used by members and agents alike). The row actions are only the transition
// verbs (claim/complete/cancel/reopen) and delete (creator/admin — judged by the server with a 403); the transition facts are emitted by the control plane.
const STATUS_ORDER: AgentTaskStatus[] = ['pending', 'in_progress', 'completed', 'cancelled']

const STATUS_TONE: Record<AgentTaskStatus, string> = {
  pending: 'bg-muted text-muted-foreground',
  in_progress: 'bg-blue-500/15 text-blue-600 dark:text-blue-400',
  completed: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  cancelled: 'bg-muted text-muted-foreground/70 line-through',
}

export function TaskBoard({
  initialTasks,
  canWrite,
}: {
  initialTasks: AgentTask[]
  canWrite: boolean
}) {
  const t = useTranslations('agentTasks')
  const locale = useLocale()
  const [tasks, setTasks] = useState<AgentTask[]>(initialTasks)
  const [filter, setFilter] = useState<AgentTaskStatus | 'all'>('all')
  const [subject, setSubject] = useState('')
  const [pending, setPending] = useState(false)

  const visible = useMemo(
    () => (filter === 'all' ? tasks : tasks.filter((task) => task.status === filter)),
    [tasks, filter]
  )
  const openCount = useMemo(
    () => tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress').length,
    [tasks]
  )

  const create = useCallback(() => {
    const trimmed = subject.trim()
    if (trimmed.length === 0) return
    void (async () => {
      setPending(true)
      try {
        const r = await createTaskAction({ subject: trimmed })
        if (!r.ok || !r.task) {
          toast.error(r.error ?? t('errorCreate'))
          return
        }
        const created = r.task
        setTasks((prev) => [created, ...prev])
        setSubject('')
      } finally {
        setPending(false)
      }
    })()
  }, [subject, t])

  const transition = useCallback(
    (id: string, status: AgentTaskStatus) => {
      void (async () => {
        setPending(true)
        try {
          const r = await updateTaskAction(id, { status })
          if (!r.ok || !r.task) {
            toast.error(r.error ?? t('errorUpdate'))
            return
          }
          const updated = r.task
          setTasks((prev) => prev.map((task) => (task.id === id ? updated : task)))
        } finally {
          setPending(false)
        }
      })()
    },
    [t]
  )

  const remove = useCallback(
    (id: string) => {
      void (async () => {
        setPending(true)
        try {
          const r = await deleteTaskAction(id)
          if (!r.ok) {
            toast.error(r.error ?? t('errorDelete'))
            return
          }
          setTasks((prev) => prev.filter((task) => task.id !== id))
        } finally {
          setPending(false)
        }
      })()
    },
    [t]
  )

  return (
    <div className="space-y-4">
      {canWrite && (
        <div className="flex items-center gap-2">
          <Input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') create()
            }}
            placeholder={t('createPlaceholder')}
            className="max-w-md"
          />
          <Button size="sm" onClick={create} disabled={pending || subject.trim().length === 0}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : t('create')}
          </Button>
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setFilter('all')}
          className={cn(
            'rounded-full border px-2.5 py-0.5 text-xs',
            filter === 'all'
              ? 'border-primary/40 bg-primary/10 text-foreground'
              : 'border-border text-muted-foreground'
          )}
        >
          {t('filterAll', { count: tasks.length })}
        </button>
        {STATUS_ORDER.map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => setFilter(status)}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-xs',
              filter === status
                ? 'border-primary/40 bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground'
            )}
          >
            {t(`status.${status}`)}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {t('openCount', { count: openCount })}
        </span>
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={<CircleDashed className="size-5" />}
          title={t('emptyTitle')}
          hint={t('emptyDescription')}
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {visible.map((task) => (
            <li key={task.id} className="flex items-center gap-3 px-3 py-2.5">
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-[11px] font-medium',
                  STATUS_TONE[task.status]
                )}
              >
                {t(`status.${task.status}`)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-foreground">{task.subject}</p>
                <p className="mt-0.5 flex items-center gap-2 text-[11.5px] text-muted-foreground">
                  {task.owner && (
                    <span className="truncate">{t('ownerLabel', { owner: task.owner })}</span>
                  )}
                  {task.origin?.agentId && (
                    <span className="inline-flex items-center gap-1">
                      <Bot className="size-3" />
                      {task.origin.agentId}
                    </span>
                  )}
                  {task.blockedBy.length > 0 && (
                    <Badge tone="outline" className="h-4 px-1.5 text-[10px]">
                      {t('blockedBy', { count: task.blockedBy.length })}
                    </Badge>
                  )}
                  <span>{fmtTimeAgo(task.updatedAt, locale)}</span>
                </p>
              </div>
              {canWrite && (
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
                  {task.status === 'pending' && (
                    <DropdownItem
                      icon={<Play className="size-3.5" />}
                      onSelect={() => transition(task.id, 'in_progress')}
                    >
                      {t('claim')}
                    </DropdownItem>
                  )}
                  {(task.status === 'pending' || task.status === 'in_progress') && (
                    <DropdownItem
                      icon={<Check className="size-3.5" />}
                      onSelect={() => transition(task.id, 'completed')}
                    >
                      {t('complete')}
                    </DropdownItem>
                  )}
                  {(task.status === 'pending' || task.status === 'in_progress') && (
                    <DropdownItem
                      icon={<X className="size-3.5" />}
                      onSelect={() => transition(task.id, 'cancelled')}
                    >
                      {t('cancel')}
                    </DropdownItem>
                  )}
                  {(task.status === 'completed' || task.status === 'cancelled') && (
                    <DropdownItem
                      icon={<RotateCcw className="size-3.5" />}
                      onSelect={() => transition(task.id, 'pending')}
                    >
                      {t('reopen')}
                    </DropdownItem>
                  )}
                  <DropdownItem
                    icon={<Trash2 className="size-3.5" />}
                    tone="danger"
                    onSelect={() => remove(task.id)}
                  >
                    {t('delete')}
                  </DropdownItem>
                </DropdownMenu>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
