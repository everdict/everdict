'use client'

import { ArrowUpRight } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { TraceEvent } from '@/entities/run'
import type { SandboxTaskSummary } from '@/entities/sandbox-session'
import { fmtUsd } from '@/shared/lib/format'
import { Callout } from '@/shared/ui/callout'
import { Link } from '@/shared/ui/link'
import { StatusIcon } from '@/shared/ui/status-pill'

import { LiveTraceList } from './live-trace-list'

// One submitted test case: the prompt the member typed, the harness's trace as it streams in, and — once the
// harness answers — its final message pulled out of that same stream. The card is a monitoring handle, not the
// record: the run detail page (a real routed page) stays one click away for scores, snapshot and sealed trace.

// The harness's answer = the last assistant message in the trace. Trace events are a passthrough shape (the web
// parses them loosely by kind), so read the fields defensively rather than asserting a union.
function finalAnswer(events: TraceEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.kind !== 'message') continue
    const fields = event as Record<string, unknown>
    if (fields.role !== 'assistant') continue
    const text = typeof fields.text === 'string' ? fields.text.trim() : ''
    if (text.length > 0) return text
  }
  return undefined
}

// What the case cost so far, summed from the harness's own llm_call events (the harness reports cost; we never
// price it ourselves). Undefined = this harness reports no cost, and the line is hidden rather than showing $0.
function totalCostUsd(events: TraceEvent[]): number | undefined {
  let total = 0
  let reported = false
  for (const event of events) {
    if (event.kind !== 'llm_call') continue
    const cost = (event as Record<string, unknown>).cost
    if (cost === null || typeof cost !== 'object') continue
    const usd = (cost as Record<string, unknown>).usd
    if (typeof usd !== 'number' || !Number.isFinite(usd)) continue
    total += usd
    reported = true
  }
  return reported ? total : undefined
}

// The failure's own words when the harness emitted them — better than a generic banner.
function failureMessage(events: TraceEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event.kind !== 'error') continue
    const message = (event as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim().length > 0) return message.trim()
  }
  return undefined
}

export function TaskCard({
  task,
  events,
  workspace,
}: {
  task: SandboxTaskSummary
  events: TraceEvent[]
  workspace: string
}) {
  const t = useTranslations('playground')
  const answer = finalAnswer(events)
  const cost = totalCostUsd(events)
  const failure = task.status === 'failed' ? (failureMessage(events) ?? t('errorTask')) : undefined

  return (
    <article className="space-y-2 rounded-lg border border-border bg-card/40 p-3">
      <div className="flex items-start gap-2">
        <StatusIcon status={task.status} className="mt-0.5 shrink-0" />
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-foreground">
          {task.taskPreview}
        </p>
        <Link
          href={`/${workspace}/run/${task.runId}`}
          aria-label={t('viewRun')}
          className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
        >
          <ArrowUpRight className="size-3.5" />
        </Link>
      </div>

      <LiveTraceList events={events} />

      {answer !== undefined && (
        <div className="rounded-md border border-primary/20 bg-primary/5 p-2.5">
          <p className="mb-1 text-[10.5px] font-[560] uppercase tracking-wide text-primary">
            {t('finalAnswer')}
          </p>
          <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-foreground">
            {answer}
          </p>
        </div>
      )}

      {failure !== undefined && <Callout tone="danger">{failure}</Callout>}

      {cost !== undefined && (
        <p className="text-[11px] text-muted-foreground">{t('cost', { amount: fmtUsd(cost) })}</p>
      )}
    </article>
  )
}
