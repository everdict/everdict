'use client'

import { useState } from 'react'
import { Bot, ChevronRight, CircleCheck, LoaderCircle, TriangleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import type { SubagentView } from '../lib/transcript'

// A burst of delegated work rendered as a live activity card (Claude Code's Task pattern): each spawn_agent
// sub-task / spawned teammate is a row with a spinner while it runs and a check/alert when it settles, so parallel
// and background delegation is visible in the conversation instead of happening silently. A row expands to the full
// task and, once finished, the sub-agent's returned summary.
export function SubagentList({ agents }: { agents: SubagentView[] }) {
  const t = useTranslations('agentChat')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  if (agents.length === 0) return null
  const running = agents.filter((a) => a.status === 'running').length
  const settled = agents.length - running

  return (
    <div className="py-0.5 pl-[2.875rem] pr-3">
      <div className="rounded-lg border border-border bg-card/60 text-[12px]">
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-[560] text-muted-foreground">
          <Bot className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span>{t('subagentsTitle')}</span>
          <span className="ml-auto flex items-center gap-1 tabular-nums text-faint">
            {running > 0 ? (
              <LoaderCircle className="size-3 animate-spin text-primary" strokeWidth={2} />
            ) : (
              <CircleCheck className="size-3 text-emerald-500" strokeWidth={2} />
            )}
            {settled}/{agents.length}
          </span>
        </div>
        <ul className="space-y-0.5 border-t border-border/70 p-1">
          {agents.map((a) => {
            const expanded = open[a.id] === true
            const hasBody = a.task.length > 0 || a.summary !== undefined
            return (
              <li key={a.id}>
                <button
                  type="button"
                  disabled={!hasBody}
                  aria-expanded={expanded}
                  onClick={() => setOpen((prev) => ({ ...prev, [a.id]: !expanded }))}
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left',
                    hasBody && 'hover:bg-accent/40'
                  )}
                >
                  {a.status === 'running' ? (
                    <LoaderCircle
                      className="size-3.5 shrink-0 animate-spin text-primary"
                      strokeWidth={2}
                    />
                  ) : a.status === 'failed' ? (
                    <TriangleAlert className="size-3.5 shrink-0 text-amber-500" strokeWidth={2} />
                  ) : (
                    <CircleCheck className="size-3.5 shrink-0 text-emerald-500" strokeWidth={2} />
                  )}
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate leading-relaxed',
                      a.status === 'running' ? 'font-[510] text-foreground' : 'text-foreground/80'
                    )}
                  >
                    {a.task}
                  </span>
                  {(a.kind === 'teammate' || a.type !== undefined) && (
                    <span className="shrink-0 rounded border border-border bg-muted/40 px-1 py-px font-mono text-[10px] text-muted-foreground">
                      {a.kind === 'teammate' ? t('subagentTeammate') : a.type}
                    </span>
                  )}
                  {hasBody && (
                    <ChevronRight
                      className={cn(
                        'size-3 shrink-0 text-muted-foreground/60 transition-transform',
                        expanded && 'rotate-90'
                      )}
                    />
                  )}
                </button>
                {expanded && (
                  <div className="space-y-1.5 px-2 pb-1.5 pt-0.5">
                    <p className="whitespace-pre-wrap break-words leading-relaxed text-foreground/80">
                      {a.task}
                    </p>
                    {a.summary !== undefined && (
                      <p className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 px-2 py-1.5 leading-relaxed text-muted-foreground">
                        {a.summary}
                      </p>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
