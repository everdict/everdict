'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { Run, TraceEvent } from '@/entities/run'
import type { SandboxTaskSummary } from '@/entities/sandbox-session'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { EmptyState } from '@/shared/ui/empty-state'

import { ExecShell } from './exec-shell'
import { SessionHeader } from './session-header'
import { TaskCard } from './task-card'
import { TaskComposer } from './task-composer'
import { TurnCard } from './turn-card'

// The attached session, rendered: header (what is booted, how long it has left) · the task feed · the composer.
// Pure presentation — every piece of state is owned by the panel container, which is the only thing that talks
// to the BFF. The feed follows new content only while the reader is already at the bottom, so scrolling back
// through an earlier task is never yanked away by a live event. A CONVERSATION session renders the same feed
// chat-shaped (TurnCard) with a thin divider where a `fresh` turn started a new thread.
export function PlaygroundView({
  record,
  harness,
  conversation = false,
  freshAvailable = false,
  freshPending = false,
  onToggleFresh,
  sessions,
  onSwitch,
  tasks,
  events,
  workspace,
  input,
  onInputChange,
  onSend,
  composerDisabled,
  closed,
  closing,
  onClose,
  onNewSession,
}: {
  record: Run
  harness?: { id: string; version: string; kind?: string }
  conversation?: boolean
  freshAvailable?: boolean
  freshPending?: boolean
  onToggleFresh?: () => void
  sessions?: { id: string; label: string }[]
  onSwitch?: (id: string) => void
  tasks: SandboxTaskSummary[]
  events: Map<string, TraceEvent[]>
  workspace: string
  input: string
  onInputChange: (value: string) => void
  onSend: () => void
  composerDisabled: boolean
  closed: boolean
  closing: boolean
  onClose: () => void
  onNewSession: () => void
}) {
  const t = useTranslations('playground')
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48)
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior })
  }, [])

  const eventCount = [...events.values()].reduce((total, list) => total + list.length, 0)
  useLayoutEffect(() => {
    if (atBottom) scrollToBottom('auto')
  }, [tasks, eventCount, atBottom, scrollToBottom])

  useEffect(() => {
    scrollToBottom('auto')
  }, [scrollToBottom])

  return (
    <div className="flex h-full flex-col">
      <SessionHeader
        record={record}
        {...(harness !== undefined ? { harness } : {})}
        conversation={conversation}
        {...(sessions !== undefined ? { sessions } : {})}
        {...(onSwitch !== undefined ? { onSwitch } : {})}
        closed={closed}
        closing={closing}
        onClose={onClose}
      />

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="h-full space-y-2 overflow-y-auto p-2.5">
          {tasks.length === 0 ? (
            <EmptyState
              title={t(conversation ? 'noTurnsTitle' : 'noTasksTitle')}
              hint={t(conversation ? 'noTurnsBody' : 'noTasksBody')}
            />
          ) : (
            tasks.map((task) => (
              <div key={task.runId} className="space-y-2">
                {conversation && task.fresh === true && (
                  <div className="flex items-center gap-2 py-1 text-[10.5px] text-faint">
                    <div className="h-px flex-1 bg-border" />
                    {t('freshDivider')}
                    <div className="h-px flex-1 bg-border" />
                  </div>
                )}
                {conversation ? (
                  <TurnCard
                    task={task}
                    events={events.get(task.runId) ?? []}
                    workspace={workspace}
                  />
                ) : (
                  <TaskCard
                    task={task}
                    events={events.get(task.runId) ?? []}
                    workspace={workspace}
                  />
                )}
              </div>
            ))
          )}
        </div>

        {!atBottom && (
          <button
            type="button"
            aria-label={t('scrollToBottom')}
            onClick={() => scrollToBottom('smooth')}
            className={cn(
              'absolute bottom-2 left-1/2 grid size-8 -translate-x-1/2 place-items-center rounded-full',
              'border border-border bg-popover text-muted-foreground shadow-pop',
              'animate-in fade-in-0 zoom-in-95 hover:text-foreground'
            )}
          >
            <ArrowDown className="size-4" />
          </button>
        )}
      </div>

      {closed ? (
        // A closed session keeps its feed — the evidence outlives the container — and offers the next boot.
        <div className="border-t border-border p-2">
          <Button variant="secondary" className="w-full" onClick={onNewSession}>
            {t('newSession')}
          </Button>
        </div>
      ) : (
        <>
          {/* Folded by default — looking inside the container is the exception, writing the next case is the
              norm. A front-door conversation holds no container, so there is no shell to offer at all. */}
          {harness?.kind !== 'service' && <ExecShell sessionId={record.id} />}
          <TaskComposer
            value={input}
            onChange={onInputChange}
            onSend={onSend}
            disabled={composerDisabled}
            conversation={conversation}
            freshAvailable={freshAvailable}
            freshPending={freshPending}
            {...(onToggleFresh !== undefined ? { onToggleFresh } : {})}
          />
        </>
      )}
    </div>
  )
}
