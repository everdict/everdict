'use client'

import { memo } from 'react'
import { CircleCheck, CircleDashed, CirclePause, ListTodo, LoaderCircle } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'

import type { TodoItemView } from '../lib/transcript'

// A `write_todos` snapshot rendered as a first-class task checklist (not a raw tool card) — the agent's plan for a
// multi-step request. Done items are checked and struck through; pending items are dashed. The in_progress item only
// animates (spinner + present-continuous "Summarizing…") while the turn is actually running (`active`) — the snapshot
// is persisted transcript state, so after a stop/interruption it would otherwise keep spinning forever and read as
// live work; halted, the step shows a static pause mark and its imperative form instead.
// Memoized like every transcript item — a keystroke in the composer must not re-render the conversation above it
// (the `todos` array identity holds because ConversationView memoizes buildTranscript).
export const TodoList = memo(function TodoList({
  todos,
  active,
}: {
  todos: TodoItemView[]
  active: boolean
}) {
  const t = useTranslations('agentChat')
  if (todos.length === 0) return null
  const done = todos.filter((td) => td.status === 'completed').length

  return (
    <div className="px-3 py-0.5">
      <div className="rounded-lg border border-border bg-card/60 px-2.5 py-2 text-[12px]">
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-[560] text-muted-foreground">
          <ListTodo className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span>{t('todoTitle')}</span>
          <span className="ml-auto tabular-nums text-faint">
            {done}/{todos.length}
          </span>
        </div>
        <ul className="space-y-1">
          {todos.map((td, i) => (
            <li key={`${td.content}:${i}`} className="flex items-start gap-1.5">
              {td.status === 'completed' ? (
                <CircleCheck
                  className="mt-0.5 size-3.5 shrink-0 text-emerald-500"
                  strokeWidth={2}
                />
              ) : td.status === 'in_progress' ? (
                active ? (
                  <LoaderCircle
                    className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary"
                    strokeWidth={2}
                  />
                ) : (
                  <CirclePause
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    strokeWidth={2}
                  />
                )
              ) : (
                <CircleDashed
                  className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50"
                  strokeWidth={2}
                />
              )}
              <span
                className={cn(
                  'leading-relaxed',
                  td.status === 'completed' && 'text-muted-foreground line-through',
                  td.status === 'in_progress' && 'font-[510] text-foreground',
                  td.status === 'pending' && 'text-foreground/80'
                )}
              >
                {td.status === 'in_progress' && active && td.activeForm
                  ? td.activeForm
                  : td.content}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
})
