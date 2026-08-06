'use client'

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  LoaderCircle,
  TriangleAlert,
  UserRoundCog,
} from 'lucide-react'
import { useTranslations } from 'next-intl'

import { useInfraPanelOptional } from '@/widgets/infra-panel'
import type { TraceEvent } from '@/entities/run'
import {
  mergeTasksById,
  sandboxSessionViewSchema,
  sandboxTaskTraceSchema,
  TurnCard,
  type SandboxSessionView,
  type SandboxTaskSummary,
} from '@/entities/sandbox-session'
import { cn } from '@/shared/lib/utils'
import { Callout } from '@/shared/ui/callout'

import type { DelegationView } from '../lib/transcript'

// A DELEGATION the agent made, rendered in the transcript — and, expanded, the agent↔delegate conversation
// itself. The delegation of a delegation is the thing that is otherwise invisible: the member sees "I handed
// this to the repair environment" and has to take it on faith. Here they read the turns.
//
// Two rules make this affordable in a chat that re-renders on every keystroke:
//   1. the component is memoized and takes PLAIN DATA only (the transcript item), like every other item;
//   2. it polls NOTHING until it is expanded — a scrolled-past card costs one div.
// Polling (not streaming) for the same reason the playground does: a card that mounts and unmounts as the
// transcript scrolls re-attaches for free, where a dropped stream would need reconnection logic for no extra
// fidelity at 2s.
const POLL_MS = 2_000

export const DelegationCard = memo(function DelegationCard({
  delegation,
  workspace,
}: {
  delegation: DelegationView
  workspace: string
}) {
  const t = useTranslations('agentChat')
  // The deep dive. Optional on purpose: the card must render anywhere the transcript does, and only offers the
  // hand-off where the infra panel actually exists to receive it.
  const panel = useInfraPanelOptional()
  const [expanded, setExpanded] = useState(false)
  const [view, setView] = useState<SandboxSessionView | null>(null)
  const [tasks, setTasks] = useState<SandboxTaskSummary[]>([])
  const [events, setEvents] = useState<Map<string, TraceEvent[]>>(() => new Map())
  // Per-turn cursors into the append-only trace buffer, plus the guards that keep the first replay and the
  // live poll from double-appending the same page — refs, so advancing one never re-subscribes the loops.
  const cursors = useRef<Record<string, number>>({})
  const pulled = useRef<Set<string>>(new Set())
  const inflight = useRef<Set<string>>(new Set())

  const sessionRunId = delegation.sessionRunId
  const ended = view !== null && view.live === undefined
  const busy = tasks.some((task) => task.status === 'running' || task.status === 'queued')

  const refresh = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/sandboxes/${encodeURIComponent(id)}`, { cache: 'no-store' })
      if (!res.ok) return
      const parsed = sandboxSessionViewSchema.safeParse(await res.json())
      if (!parsed.success) return
      setView(parsed.data)
      if (parsed.data.live !== undefined)
        setTasks((prev) => mergeTasksById(prev, parsed.data.live?.tasks ?? []))
    } catch {
      // Silent — retried on the next tick.
    }
  }, [])

  const pullTrace = useCallback(async (id: string, taskId: string) => {
    if (inflight.current.has(taskId)) return
    inflight.current.add(taskId)
    try {
      const since = cursors.current[taskId] ?? 0
      const res = await fetch(
        `/api/sandboxes/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}/trace${
          since > 0 ? `?since=${since}` : ''
        }`,
        { cache: 'no-store' }
      )
      if (!res.ok) return
      const parsed = sandboxTaskTraceSchema.safeParse(await res.json())
      if (!parsed.success) return
      const page = parsed.data
      cursors.current[taskId] = page.nextCursor
      if (page.events.length > 0)
        setEvents((prev) => {
          const next = new Map(prev)
          next.set(taskId, [...(next.get(taskId) ?? []), ...page.events])
          return next
        })
      setTasks((prev) =>
        prev.map((task) => (task.runId === taskId ? { ...task, status: page.status } : task))
      )
    } catch {
      // Silent — retried on the next tick.
    } finally {
      inflight.current.delete(taskId)
    }
  }, [])

  // Expanded: attach. Reconciles the session, then replays every turn we have not read and follows the running
  // one. Skipped while the document is hidden, and torn down the moment the card folds again.
  useEffect(() => {
    if (!expanded || sessionRunId === undefined) return
    let cancelled = false
    void refresh(sessionRunId)
    const timer = setInterval(() => {
      if (cancelled || (typeof document !== 'undefined' && document.hidden)) return
      void refresh(sessionRunId)
    }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [expanded, sessionRunId, refresh])

  // Full replay for any turn not read yet (a just-expanded card rebuilding the whole conversation), then the
  // running turn's live tail.
  useEffect(() => {
    if (!expanded || sessionRunId === undefined) return
    const fresh = tasks.filter((task) => !pulled.current.has(task.runId))
    if (fresh.length === 0) return
    for (const task of fresh) pulled.current.add(task.runId)
    void (async () => {
      for (const task of fresh) await pullTrace(sessionRunId, task.runId)
    })()
  }, [expanded, sessionRunId, tasks, pullTrace])

  const activeTaskId =
    tasks.find((t2) => t2.status === 'running' || t2.status === 'queued')?.runId ?? null
  useEffect(() => {
    if (!expanded || sessionRunId === undefined || activeTaskId === null) return
    let cancelled = false
    const tick = () => {
      if (cancelled || (typeof document !== 'undefined' && document.hidden)) return
      void pullTrace(sessionRunId, activeTaskId)
    }
    tick()
    const timer = setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [expanded, sessionRunId, activeTaskId, pullTrace])

  const profileLabel = view?.live?.profile?.id ?? delegation.profileId
  const version = view?.live?.profile?.version

  return (
    <div className="px-3 py-0.5">
      <div className="rounded-lg border border-border bg-card/60 text-[12px]">
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          disabled={delegation.sessionRunId === undefined}
          className={cn(
            'flex w-full items-center gap-1.5 px-2.5 py-2 text-left',
            delegation.sessionRunId !== undefined && 'hover:bg-elevated/60'
          )}
        >
          {delegation.sessionRunId !== undefined &&
            (expanded ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            ))}
          <UserRoundCog className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            <span className="font-[560] text-foreground">
              {t('delegatedTo', { profile: profileLabel })}
            </span>
            {version !== undefined && <span className="ml-1 text-faint">@{version}</span>}
            {delegation.goal.length > 0 && (
              <span className="ml-1.5 text-muted-foreground">— {delegation.goal}</span>
            )}
          </span>
          {delegation.status === 'running' ? (
            <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : delegation.status === 'failed' ? (
            <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
          ) : busy ? (
            <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <CircleCheck className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          {tasks.length > 0 && (
            <span className="shrink-0 tabular-nums text-faint">{tasks.length}</span>
          )}
        </button>

        {delegation.status === 'failed' && (
          <div className="px-2.5 pb-2">
            <Callout tone="danger">{delegation.detail ?? t('delegationFailed')}</Callout>
          </div>
        )}

        {expanded && delegation.sessionRunId !== undefined && (
          <div className="space-y-2 border-t border-border px-2.5 py-2">
            {tasks.length === 0 ? (
              // A settled session keeps its record but not its live half, so an old conversation has no turns
              // to replay — say that, rather than draw an empty conversation and let it read as "nothing happened".
              <p className="text-[11.5px] text-muted-foreground">
                {ended ? t('delegationEnded') : t('delegationNoTurns')}
              </p>
            ) : (
              tasks.map((task) => (
                <TurnCard
                  key={task.runId}
                  task={task}
                  events={events.get(task.runId) ?? []}
                  workspace={workspace}
                />
              ))
            )}
            {panel !== null && !ended && (
              <button
                type="button"
                onClick={() => panel.openPlayground({ sessionId: delegation.sessionRunId ?? '' })}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                {t('delegationOpenInPlayground')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
})
