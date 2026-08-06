'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { runSchema, type TraceEvent } from '@/entities/run'
import {
  mergeTasksById,
  sandboxListSchema,
  sandboxSessionViewSchema,
  sandboxTaskTraceSchema,
  type SandboxSessionView,
  type SandboxTaskSummary,
} from '@/entities/sandbox-session'
import { Callout } from '@/shared/ui/callout'

import { BootForm, type BootInput } from './boot-form'
import { PlaygroundView } from './playground-view'

// The harness playground — the infra panel's 'playground' tab. A member boots a registered harness into a warm
// sandbox session (one container held open on the control plane) and then submits ad-hoc test cases into it, one
// at a time, watching the harness's own TraceEvents arrive. Each test case is its own child Run grouped to the
// session, so anything worth keeping is already a first-class record: the card links straight to its run page.
//
// ALL continuity is server-side. The purpose-built panel tabs unmount when the member switches tabs, so this
// component keeps nothing across a remount — it re-discovers the live session (GET /sandboxes), then replays each
// task's trace from cursor 0. That is also why polling, not streaming, is the transport here: a poll re-attaches
// for free where a dropped stream would need reconnection logic for no extra fidelity at 2s.
//
// This container owns every piece of state and is the only thing that talks to the BFF; PlaygroundView renders.

type PanelState = 'unconfigured' | 'none' | 'booting' | 'attached' | 'closing' | 'closed'

const POLL_BUSY_MS = 2_000 // a task is running — reconcile at the same cadence as its trace
const POLL_IDLE_MS = 6_000 // nothing running — the TTL countdown ticks locally, so this only corrects it
const POLL_TRACE_MS = 2_000

// A control-plane error envelope's own words ({code,message}) — worth showing verbatim ("provide harness.image",
// budget/cap messages). The BFF's transport failure carries {error} instead.
function messageOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const { message, error } = body as { message?: unknown; error?: unknown }
  if (typeof message === 'string' && message.trim().length > 0) return message
  if (typeof error === 'string' && error.trim().length > 0) return error
  return undefined
}

export function HarnessPlaygroundPanel({
  pendingTarget,
  onConsumeTarget,
  canSubmit = false,
  workspace,
}: {
  // A harness detail page asked to test THIS harness here — prefills the boot form. It never auto-boots:
  // booting spends a container, so the member presses the button.
  pendingTarget?: { harnessId: string; version?: string } | { sessionId: string } | null
  onConsumeTarget?: () => void
  canSubmit?: boolean
  workspace: string
}) {
  const t = useTranslations('playground')
  const [state, setState] = useState<PanelState>('none')
  const [view, setView] = useState<SandboxSessionView | null>(null)
  // Every live session on the control plane (newest first) — the reattach surface on mount AND the header
  // switcher's options when the member is holding more than one harness open.
  const [sessions, setSessions] = useState<SandboxSessionView[]>([])
  const [tasks, setTasks] = useState<SandboxTaskSummary[]>([])
  const [events, setEvents] = useState<Map<string, TraceEvent[]>>(() => new Map())
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // Conversation sessions: the next message starts a NEW thread (same environment). Armed by the composer's
  // toggle, cleared after the send that carried it.
  const [freshPending, setFreshPending] = useState(false)
  const [bootError, setBootError] = useState<string>()
  const [prefill, setPrefill] = useState<{ harnessId: string; version?: string }>()
  // Per-task poll cursors into the append-only trace buffer, the tasks already replayed once, and the fetches
  // currently out — refs, so the poll loops never re-subscribe when one of them advances.
  const cursors = useRef<Record<string, number>>({})
  const pulled = useRef<Set<string>>(new Set())
  const inflight = useRef<Set<string>>(new Set())

  const sessionId = view?.record.id ?? null
  const busy =
    (view?.live?.busy ?? false) ||
    tasks.some((task) => task.status === 'running' || task.status === 'queued')

  const applyView = useCallback((next: SandboxSessionView) => {
    setView(next)
    if (next.live !== undefined) setTasks((prev) => mergeTasksById(prev, next.live?.tasks ?? []))
    // `live` absent = the session is no longer held open here (closed, expired, or lost to a restart).
    setState(next.live === undefined ? 'closed' : 'attached')
  }, [])

  const refresh = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/sandboxes/${encodeURIComponent(id)}`, { cache: 'no-store' })
        if (!res.ok) return
        const parsed = sandboxSessionViewSchema.safeParse(await res.json())
        if (parsed.success) applyView(parsed.data)
      } catch {
        // Silent — retried on the next tick.
      }
    },
    [applyView]
  )

  // Pull the live-session list and remember it. Returns it so the caller decides what to attach to; null means
  // "could not tell" (transport failure, or no sandbox driver at all — which sets the unconfigured state).
  const discover = useCallback(async (): Promise<SandboxSessionView[] | null> => {
    try {
      const res = await fetch('/api/sandboxes', { cache: 'no-store' })
      // 404 = no sandbox driver composed. That is a deployment fact, not a member error — say so plainly
      // instead of offering a boot button whose only possible answer is the same 404.
      if (res.status === 404) {
        setState('unconfigured')
        return null
      }
      if (!res.ok) return null
      const parsed = sandboxListSchema.safeParse(await res.json())
      if (!parsed.success) return null
      const newestFirst = [...parsed.data.sessions].sort((a, b) =>
        b.record.createdAt.localeCompare(a.record.createdAt)
      )
      setSessions(newestFirst)
      return newestFirst
    } catch {
      return null
    }
  }, [])

  // Mount: is this deployment even wired for sandboxes, and is a session of ours still alive?
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const live = await discover()
      if (cancelled || live === null || live.length === 0) return
      applyView(live[0])
    })()
    return () => {
      cancelled = true
    }
  }, [discover, applyView])

  // A detail page's "test this harness" entry — read once, then clear the buffer so a later remount does not
  // re-inject the same prefill over the member's own picks.
  useEffect(() => {
    if (!pendingTarget) return
    // A harness reference PREFILLS the boot form (booting spends a container — the member presses the button);
    // a session id ATTACHES, because that session is already alive and someone is asking to watch it.
    if ('sessionId' in pendingTarget) void refresh(pendingTarget.sessionId)
    else setPrefill(pendingTarget)
    onConsumeTarget?.()
  }, [pendingTarget, onConsumeTarget, refresh])

  // Session reconciliation — fast while a task runs, slow when idle. Skipped while the document is hidden.
  useEffect(() => {
    if (state !== 'attached' || sessionId === null) return
    let cancelled = false
    const timer = setInterval(
      () => {
        if (cancelled || (typeof document !== 'undefined' && document.hidden)) return
        void refresh(sessionId)
      },
      busy ? POLL_BUSY_MS : POLL_IDLE_MS
    )
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [state, sessionId, busy, refresh])

  // One page of a task's trace, from wherever this task's cursor stands (0 = full replay). The inflight guard
  // keeps the first-replay pass and the live poll from double-appending the same page.
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
      // The trace page carries the task's own status, one poll fresher than the session view — so the card
      // settles the moment the stream reports done rather than a reconciliation later.
      setTasks((prev) =>
        prev.map((task) => (task.runId === taskId ? { ...task, status: page.status } : task))
      )
    } catch {
      // Silent — retried on the next tick.
    } finally {
      inflight.current.delete(taskId)
    }
  }, [])

  // Full replay for any task we have not read yet — a remounted panel rebuilding the whole feed, or a task
  // that finished while the panel was on another tab.
  useEffect(() => {
    if (sessionId === null) return
    const fresh = tasks.filter((task) => !pulled.current.has(task.runId))
    if (fresh.length === 0) return
    for (const task of fresh) pulled.current.add(task.runId)
    void (async () => {
      for (const task of fresh) await pullTrace(sessionId, task.runId)
    })()
  }, [tasks, sessionId, pullTrace])

  // The running task's live trace. Only one task runs at a time (the control plane refuses the rest with 409),
  // so this is a single poll that stops as soon as the task is terminal.
  const activeTaskId =
    tasks.find((task) => task.status === 'running' || task.status === 'queued')?.runId ?? null
  useEffect(() => {
    if (sessionId === null || activeTaskId === null) return
    let cancelled = false
    const tick = () => {
      if (cancelled || (typeof document !== 'undefined' && document.hidden)) return
      void pullTrace(sessionId, activeTaskId)
    }
    tick()
    const timer = setInterval(tick, POLL_TRACE_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [sessionId, activeTaskId, pullTrace])

  const boot = useCallback(
    async (bootInput: BootInput) => {
      setBootError(undefined)
      setState('booting')
      try {
        const res = await fetch('/api/sandboxes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            harness: {
              id: bootInput.harnessId,
              version: bootInput.version,
              ...(bootInput.image !== undefined ? { image: bootInput.image } : {}),
              ...(bootInput.conversation === true ? { conversation: true } : {}),
            },
            ...(bootInput.runtime !== undefined ? { runtime: bootInput.runtime } : {}),
            ttlSec: bootInput.ttlSec,
          }),
        })
        const body: unknown = await res.json()
        if (res.status === 404) {
          setState('unconfigured')
          return
        }
        if (!res.ok) {
          setState('none')
          // The control plane's own words: an imageless spec asks for harness.image, a cap says which cap.
          setBootError(messageOf(body) ?? t('errorBoot'))
          return
        }
        const parsed = runSchema.safeParse(body)
        if (!parsed.success) {
          setState('none')
          setBootError(t('errorBoot'))
          return
        }
        setView({ record: parsed.data })
        setState('attached')
        void refresh(parsed.data.id) // pick up the live half (TTL, harness, empty task list)
        void discover() // the switcher must know about the session that just appeared
      } catch {
        setState('none')
        setBootError(t('errorBoot'))
      }
    },
    [refresh, discover, t]
  )

  const submit = useCallback(async () => {
    const text = input.trim()
    if (text.length === 0 || sessionId === null || submitting || busy || state !== 'attached')
      return
    const fresh = freshPending
    setSubmitting(true)
    setInput('')
    try {
      const res = await fetch(`/api/sandboxes/${encodeURIComponent(sessionId)}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: text, ...(fresh ? { fresh: true } : {}) }),
      })
      const body: unknown = await res.json()
      // 409 = a task is still running. The prompt is the member's work — hand it back rather than dropping it.
      if (res.status === 409) {
        setInput(text)
        toast.info(t('errorBusy'))
        return
      }
      if (!res.ok) {
        setInput(text)
        toast.error(messageOf(body) ?? t('errorSubmit'))
        return
      }
      const parsed = runSchema.safeParse(body)
      if (parsed.success) {
        // The 202's child run IS the handle — card it optimistically; the next reconciliation replaces this
        // with the session's own summary (same runId, so the card never blinks).
        setTasks((prev) =>
          mergeTasksById(prev, [
            {
              runId: parsed.data.id,
              caseId: parsed.data.caseId,
              status: parsed.data.status,
              taskPreview: text,
              submittedAt: parsed.data.createdAt,
              eventCount: 0,
              ...(fresh ? { fresh: true } : {}),
            },
          ])
        )
        setFreshPending(false) // the reset was carried by THIS send — the next message continues normally
      }
      void refresh(sessionId)
    } catch {
      setInput(text)
      toast.error(t('errorSubmit'))
    } finally {
      setSubmitting(false)
    }
  }, [input, sessionId, submitting, busy, state, freshPending, refresh, t])

  const close = useCallback(async () => {
    if (sessionId === null) return
    setState('closing')
    try {
      const res = await fetch(`/api/sandboxes/${encodeURIComponent(sessionId)}/close`, {
        method: 'POST',
      })
      if (res.ok) {
        const parsed = runSchema.safeParse(await res.json())
        if (parsed.success) setView({ record: parsed.data })
      }
    } catch {
      // The control plane settles the record either way; the panel just stops polling.
    } finally {
      setState('closed')
      void discover() // drop the torn-down session from the switcher
    }
  }, [sessionId, discover])

  // Start over — the closed session's feed is evidence, but a new session is a new container, so nothing carries.
  const newSession = useCallback(() => {
    setView(null)
    setTasks([])
    setEvents(new Map())
    cursors.current = {}
    pulled.current = new Set()
    setBootError(undefined)
    setInput('')
    setFreshPending(false)
    setState('none')
  }, [])

  // Attach to a DIFFERENT live session. Its container has its own task history, so the feed is rebuilt from
  // scratch: clearing `pulled` sends the replay effect back through every task's trace from cursor 0 — the same
  // reattach path a remount takes. The list entry renders immediately, then the fetch fills in the live half.
  const switchTo = useCallback(
    (id: string) => {
      if (id === sessionId) return
      setTasks([])
      setEvents(new Map())
      cursors.current = {}
      pulled.current = new Set()
      setInput('')
      setFreshPending(false)
      const known = sessions.find((session) => session.record.id === id)
      if (known) applyView(known)
      void refresh(id)
    },
    [sessionId, sessions, applyView, refresh]
  )

  // Two sessions can run the same harness@version, so the run-id tail is what actually tells them apart.
  const sessionOptions = sessions.map((session) => {
    const harness = session.live?.harness ?? session.record.harness
    return {
      id: session.record.id,
      label: `${harness.id}@${harness.version} · ${session.record.id.slice(-6)}`,
    }
  })

  if (state === 'unconfigured')
    return (
      <div className="p-4">
        <Callout tone="muted" hint={t('notConfiguredBody')}>
          {t('notConfiguredTitle')}
        </Callout>
      </div>
    )

  if (view === null)
    return (
      <div className="h-full overflow-y-auto">
        <BootForm
          canSubmit={canSubmit}
          booting={state === 'booting'}
          {...(bootError !== undefined ? { error: bootError } : {})}
          {...(prefill !== undefined ? { prefill } : {})}
          onBoot={(bootInput) => void boot(bootInput)}
        />
      </div>
    )

  // Conversation-ness rides the live view (frontdoor = always, playground = when booted that way); the record's
  // session half remembers it when the live half is gone. `fresh` exists only for a PROCESS conversation — a
  // service conversation's thread is its session, and the server refuses the flag there.
  const conversation = view.live?.conversation ?? view.record.session?.conversation ?? false
  const harnessKind = view.live?.harness?.kind
  const freshAvailable = conversation && harnessKind !== 'service'

  return (
    <PlaygroundView
      record={view.record}
      {...(view.live?.harness !== undefined ? { harness: view.live.harness } : {})}
      conversation={conversation}
      freshAvailable={freshAvailable}
      freshPending={freshPending}
      onToggleFresh={() => setFreshPending((pending) => !pending)}
      sessions={sessionOptions}
      onSwitch={switchTo}
      tasks={tasks}
      events={events}
      workspace={workspace}
      input={input}
      onInputChange={setInput}
      onSend={() => void submit()}
      composerDisabled={!canSubmit || submitting || busy || state !== 'attached'}
      closed={state === 'closed'}
      closing={state === 'closing'}
      onClose={() => void close()}
      onNewSession={newSession}
    />
  )
}
