'use client'

import { useState } from 'react'
import { ArrowUpRight, ChevronDown, ChevronRight } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { TraceEvent } from '@/entities/run'
import type { SandboxTaskSummary } from '@/entities/sandbox-session'
import { fmtUsd } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Callout } from '@/shared/ui/callout'
import { Link } from '@/shared/ui/link'
import { StatusIcon } from '@/shared/ui/status-pill'

import { failureMessage, finalAnswer, totalCostUsd } from '../lib/trace'
import { LiveTraceList } from './live-trace-list'

// One conversation TURN, chat-shaped: the member's message as a compact right-aligned bubble, the harness's
// working trace visible while the turn runs and folded behind a count once it settles, then the assistant's
// reply as the prominent plain message (no "final answer" framing — in a conversation the reply IS the
// content). The run link keeps the turn a first-class record like any playground case.
export function TurnCard({
  task,
  events,
  workspace,
}: {
  task: SandboxTaskSummary
  events: TraceEvent[]
  workspace: string
}) {
  const t = useTranslations('playground')
  const [traceOpen, setTraceOpen] = useState(false)
  const running = task.status === 'running' || task.status === 'queued'
  const answer = finalAnswer(events)
  const cost = totalCostUsd(events)
  const failure = task.status === 'failed' ? (failureMessage(events) ?? t('errorTask')) : undefined

  return (
    <article className="space-y-2">
      <div className="flex justify-end">
        <div className="flex max-w-[85%] items-start gap-1.5">
          <p className="whitespace-pre-wrap break-words rounded-lg rounded-tr-sm bg-primary/10 px-2.5 py-1.5 text-[12.5px] leading-relaxed text-foreground">
            {task.taskPreview}
          </p>
        </div>
      </div>

      <div className="flex items-start gap-2">
        <StatusIcon status={task.status} className="mt-1 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1.5">
          {running ? (
            <LiveTraceList events={events} />
          ) : (
            events.length > 0 && (
              <div>
                <button
                  type="button"
                  onClick={() => setTraceOpen((open) => !open)}
                  className={cn(
                    'flex items-center gap-1 text-[11px] text-muted-foreground',
                    'hover:text-foreground'
                  )}
                >
                  {traceOpen ? (
                    <ChevronDown className="size-3" />
                  ) : (
                    <ChevronRight className="size-3" />
                  )}
                  {t('turnTrace', { count: events.length })}
                </button>
                {traceOpen && <LiveTraceList events={events} />}
              </div>
            )
          )}

          {answer !== undefined && (
            <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-foreground">
              {answer}
            </p>
          )}

          {failure !== undefined && <Callout tone="danger">{failure}</Callout>}

          <div className="flex items-center gap-2 text-[10.5px] text-faint">
            {cost !== undefined && <span>{t('cost', { amount: fmtUsd(cost) })}</span>}
            <Link
              href={`/${workspace}/run/${task.runId}`}
              aria-label={t('viewRun')}
              className="flex items-center gap-0.5 hover:text-foreground"
            >
              {t('viewRun')}
              <ArrowUpRight className="size-3" />
            </Link>
          </div>
        </div>
      </div>
    </article>
  )
}
