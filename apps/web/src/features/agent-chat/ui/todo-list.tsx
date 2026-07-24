'use client'

import { CircleCheck, CircleDashed, ListTodo, LoaderCircle } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import type { TodoItemView } from '../lib/transcript'

// A `write_todos` snapshot rendered as a first-class task checklist (not a raw tool card) — the agent's plan for a
// multi-step request. The in_progress item shows its present-continuous form ("Summarizing…") and a spinner; done
// items are checked and struck through; pending items are dashed. Gives the user a legible "here's my plan / here's
// where I am" at a glance instead of a JSON blob.
export function TodoList({ todos }: { todos: TodoItemView[] }) {
  const t = useTranslations('agentChat')
  if (todos.length === 0) return null
  const done = todos.filter((td) => td.status === 'completed').length

  return (
    <div className="py-0.5 pl-[2.875rem] pr-3">
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
                <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-500" strokeWidth={2} />
              ) : td.status === 'in_progress' ? (
                <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" strokeWidth={2} />
              ) : (
                <CircleDashed className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50" strokeWidth={2} />
              )}
              <span
                className={cn(
                  'leading-relaxed',
                  td.status === 'completed' && 'text-muted-foreground line-through',
                  td.status === 'in_progress' && 'font-[510] text-foreground',
                  td.status === 'pending' && 'text-foreground/80'
                )}
              >
                {td.status === 'in_progress' && td.activeForm ? td.activeForm : td.content}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
