'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import {
  agentMessageListSchema,
  agentMessageSchema,
  agentSessionListSchema,
  agentSessionSchema,
  agentTeammateListSchema,
  startsFreshConversation,
  type AgentAttachmentInput,
  type AgentChatMission,
  type AgentMessage,
  type AgentPermissionMode,
  type AgentReference,
  type AgentSession,
  type AgentTeammate,
} from '@/entities/agent-session'
import {
  analysisArtifactSchema,
  analysisArtifactsResponseSchema,
  type AnalysisArtifact,
} from '@/entities/analysis-artifact'
import { modelsSchema } from '@/entities/model'
import { useRefresh } from '@/shared/lib/use-refresh'

import { pushPromptHistory } from '../lib/prompt-history'
import { ConversationView, type PendingUserMessage } from './conversation-view'
import type { ChatUser } from './message-row'
import type { PendingPermission } from './permission-prompt'
import type { TeammateSpawnInput } from './team-menu'

// The agent conversation surface for the infra panel's "agent" tab. Owns all state + I/O; delegates rendering to
// ConversationView (the chat is ALWAYS on screen — entering the tab lands on a ready-to-type draft, and history
// lives in the header's SessionMenu dropdown, so the user never leaves the chat). A draft (activeId === null) has
// no server session yet; the first send creates one lazily (so opening the tab never litters empty sessions).
// Talks only to the same-origin BFF (/api/agent/*). A turn streams over SSE: `delta` events grow the live
// assistant bubble, `message` events merge each persisted record (so tool cards + the finalized answer appear
// live). The turn OUTLIVES this connection — the agent server keeps the loop running when the client detaches —
// so switching conversations (or unmounting the tab) loses nothing: opening a session with a live turn
// re-attaches to its stream (GET /stream, sessions carry the computed `live` flag), a concurrent send is refused
// with 409 (re-attach instead of double-running), and Stop is the explicit POST /stop, not a dropped connection.

function mergeMessages(prev: AgentMessage[], incoming: AgentMessage[]): AgentMessage[] {
  const byId = new Map(prev.map((m) => [m.id, m]))
  for (const m of incoming) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

// The shared SSE frame reader — sending (POST /chat) and re-attaching (GET /stream) consume the same event vocabulary through one parser.
async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: unknown) => void
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      let ev = 'message'
      let dataStr = ''
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim()
        else if (line.startsWith('data:')) dataStr += line.slice(5).trim()
      }
      if (dataStr.length > 0) {
        try {
          onEvent(ev, JSON.parse(dataStr))
        } catch {
          // skip a malformed frame
        }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}

// pendingMention (+ onConsumeMention) is threaded down from the infra panel: an entity detail page asked to
// analyze its entity here, so drop it into the composer as a reference chip and/or pre-type a draft prompt
// (nothing auto-sends — the member reviews and presses send). It may also carry a MISSION — a domain-specific
// entry such as Settings › Skills detail's "edit by conversation" — which lands on a fresh draft and reframes the empty
// chat (title/body/suggestions) for that task; the surface itself is unchanged. pendingSession (+ onConsumeSession) is the same
// channel for a comment thread's "view details": open a SPECIFIC (workspace-visible discussion) session and WATCH
// it — a background turn streams its SSE to nobody, so the panel polls /messages?since= + /pending instead. The
// prop shapes are declared inline (not imported from the widget) to keep the FSD import direction downward-only.
export function AgentChatPanel({
  workspace,
  pendingMention,
  onConsumeMention,
  pendingSession,
  onConsumeSession,
  user,
}: {
  workspace: string
  pendingMention?: {
    ref?: AgentReference
    prompt?: string
    mission?: AgentChatMission
    fresh?: boolean
  } | null
  onConsumeMention?: () => void
  pendingSession?: { id: string } | null
  onConsumeSession?: () => void
  user?: ChatUser
}) {
  const t = useTranslations('agentChat')
  const router = useRouter()
  const refresh = useRefresh()
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  // Emitted analysis artifacts (charts/tables/reports) — hydrated per session, appended live via SSE `artifact`.
  const [artifacts, setArtifacts] = useState<AnalysisArtifact[]>([])
  // My messages that were sent and have not come back as a server record yet. A `queued` one was slipped into a RUNNING turn
  // (a redirect), so it belongs BELOW the answer in progress — a first send belongs above it. It is a list rather than one slot
  // because consecutive redirects genuinely happen (with a single slot the earlier one vanishes from the screen).
  const [pendingUsers, setPendingUsers] = useState<PendingUserMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [references, setReferences] = useState<AgentReference[]>([])
  // The mission a dedicated entry arrived with (a skill edit, etc.) plus the name of its subject — the empty conversation's
  // wording and suggestions are framed for that work. The subject is taken verbatim from the reference chip that arrived with it (no guessing). It clears when the conversation changes.
  const [mission, setMission] = useState<{ kind: AgentChatMission; target?: string } | null>(null)
  const [attachments, setAttachments] = useState<AgentAttachmentInput[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [streamingReasoning, setStreamingReasoning] = useState('')
  // The transient-trouble banner: the loop is waiting to retry a model failure (`retry`) or has switched to the fallback model
  // (`fallback`) — without it a long wait looks like a frozen panel. Any progress event (delta/reasoning/message) clears it.
  const [streamNotice, setStreamNotice] = useState<
    | { kind: 'retry'; attempt: number; delayMs: number; persistent?: boolean }
    | { kind: 'fallback'; to: string }
    | null
  >(null)
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([])
  const [modelIds, setModelIds] = useState<string[]>([])
  // The model chosen while still a draft (no session yet) — it rides along on the first send that creates the session.
  const [draftModel, setDraftModel] = useState<string | null>(null)
  // The permission mode chosen in the draft — 'default' (always confirm) is the default, so it is not sent on create when unchanged.
  const [draftPermissionMode, setDraftPermissionMode] = useState<AgentPermissionMode>('default')
  // The caller's live teammates (docs/architecture/agent-teams.md) — long-lived autonomous agents that watch platform
  // events and wake to react. Loaded on mount and refreshed after each turn (the agent can self-spawn via a tool).
  const [teammates, setTeammates] = useState<AgentTeammate[]>([])
  const abortRef = useRef<AbortController | null>(null)
  // What decides WHICH conversation's transcript to reconcile when a stream settles — if the conversation moved meanwhile,
  // somebody else's transcript is not mixed in.
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId
  // Skip exactly one re-attach right after an explicit stop (see stop).
  const suppressAttachRef = useRef(false)
  // Watch mode (a discussion session opened from a comment thread): a background turn streams SSE to nobody, so
  // while this session is active the panel polls its persisted transcript + parked approvals instead.
  const [watchId, setWatchId] = useState<string | null>(null)
  const maxSeqRef = useRef(-1)
  // Live analysis-canvas presence (same window): the analyze dashboard / open View announces its state on
  // mount/change and clears with a null on unmount — shown as a "canvas linked" chip above the composer, so
  // the member KNOWS the agent sees what they see. Send-time capture stays its own synchronous round-trip.
  const [canvasLink, setCanvasLink] = useState<{ viewName?: string } | null>(null)
  useEffect(() => {
    const onState = (e: Event) => {
      const detail = (e as CustomEvent<unknown>).detail
      if (detail === null || typeof detail !== 'object') {
        setCanvasLink(null)
        return
      }
      const d = detail as { config?: unknown; viewName?: unknown }
      if (d.config === null || typeof d.config !== 'object') return
      const viewName = typeof d.viewName === 'string' ? d.viewName : undefined
      setCanvasLink((prev) =>
        prev && prev.viewName === viewName ? prev : viewName ? { viewName } : {}
      )
    }
    window.addEventListener('everdict:canvas-state', onState)
    // The canvas may have mounted before this panel — ask it to announce itself.
    window.dispatchEvent(new Event('everdict:canvas-state-request'))
    return () => window.removeEventListener('everdict:canvas-state', onState)
  }, [])

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/sessions', { cache: 'no-store' })
      if (!res.ok) return
      const parsed = agentSessionListSchema.safeParse(await res.json())
      if (parsed.success) setSessions(parsed.data.sessions)
    } catch {
      // silent — retried on the next open/send
    }
  }, [])

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])

  const loadTeammates = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/teammates', { cache: 'no-store' })
      if (!res.ok) return
      const parsed = agentTeammateListSchema.safeParse(await res.json())
      if (parsed.success) setTeammates(parsed.data.teammates)
    } catch {
      // silent — refreshed after the next turn/spawn
    }
  }, [])

  useEffect(() => {
    void loadTeammates()
  }, [loadTeammates])

  const spawnTeammate = useCallback(
    async (spawnInput: TeammateSpawnInput) => {
      try {
        const res = await fetch('/api/agent/teammates', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(spawnInput),
        })
        if (!res.ok) throw new Error('spawn failed')
        toast.success(t('team.spawned', { name: spawnInput.name }))
        void loadTeammates()
      } catch {
        toast.error(t('errorGeneric'))
      }
    },
    [loadTeammates, t]
  )

  const stopTeammate = useCallback(
    async (id: string) => {
      // Optimistic — drop it immediately; a failure reloads the true roster.
      setTeammates((prev) => prev.filter((tm) => tm.id !== id))
      try {
        const res = await fetch(`/api/agent/teammates/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        })
        if (!res.ok) throw new Error('stop failed')
      } catch {
        toast.error(t('errorGeneric'))
        void loadTeammates()
      }
    },
    [loadTeammates, t]
  )

  // The workspace's registered models power the per-conversation model picker (same ids the agent resolves to
  // run the turn). Best-effort: no registry / no permission → an empty list, and the picker offers only "default".
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/models', { cache: 'no-store' })
        if (!res.ok) return
        const parsed = modelsSchema.safeParse(await res.json())
        if (parsed.success) setModelIds(parsed.data.map((m) => m.id))
      } catch {
        // silent — the picker degrades to "workspace default"
      }
    })()
  }, [])

  useEffect(() => {
    if (!activeId) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/agent/sessions/${encodeURIComponent(activeId)}/messages`, {
          cache: 'no-store',
        })
        if (!res.ok) return
        const parsed = agentMessageListSchema.safeParse(await res.json())
        // MERGE, not replace: on a switch it is already empty, and when the first send just created the session an empty server
        // response must not overwrite the record that arrived first over the stream.
        if (!cancelled && parsed.success)
          setMessages((prev) => mergeMessages(prev, parsed.data.messages))
      } catch {
        // silent
      }
    })()
    // This conversation's analysis artifacts (charts/tables/reports) — rendered inline in the transcript in time order.
    void (async () => {
      try {
        const res = await fetch(`/api/agent/sessions/${encodeURIComponent(activeId)}/artifacts`, {
          cache: 'no-store',
        })
        if (!res.ok) return
        const parsed = analysisArtifactsResponseSchema.safeParse(await res.json())
        if (!cancelled && parsed.success)
          setArtifacts((prev) => {
            const seen = new Set(prev.map((a) => a.id))
            return [...prev, ...parsed.data.artifacts.filter((a) => !seen.has(a.id))]
          })
      } catch {
        // silent — the transcript renders without artifacts
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeId])

  // Switch context to another conversation — only the reader is torn down, so the previous session's stream is not mixed into the
  // new screen. The turn itself keeps running on the server, and coming back re-attaches to the live stream.
  const switchTo = useCallback((id: string | null) => {
    abortRef.current?.abort()
    suppressAttachRef.current = false // the attach suppression is scoped to THAT conversation — a new one re-attaches normally
    setActiveId(id)
    setMessages([])
    setPendingUsers([])
    setArtifacts([])
    setWatchId(null) // watch mode is scoped to the session that opened it — moving to another conversation stops the polling
    setPendingPermissions([])
    setMission(null) // a mission belongs only to the conversation it was entered through
  }, [])

  const newConversation = useCallback(() => {
    switchTo(null)
    setDraftModel(null)
    setDraftPermissionMode('default')
  }, [switchTo])

  const openSession = useCallback(
    (id: string) => {
      if (id === activeId) return
      switchTo(id)
    },
    [activeId, switchTo]
  )

  const deleteSession = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/agent/sessions/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        })
        if (!res.ok) return
        setSessions((prev) => prev.filter((s) => s.id !== id))
        if (activeId === id) switchTo(null)
      } catch {
        toast.error(t('errorGeneric'))
      }
    },
    [activeId, switchTo, t]
  )

  const renameSession = useCallback(
    async (id: string, title: string) => {
      const trimmed = title.trim()
      if (trimmed.length === 0) return
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: trimmed } : s)))
      try {
        await fetch(`/api/agent/sessions/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: trimmed }),
        })
      } catch {
        void loadSessions()
      }
    },
    [loadSessions]
  )

  const changeModel = useCallback(
    async (model: string | null) => {
      if (!activeId) {
        // A draft has no server session yet — hold it locally and send it with the create request on the first send.
        setDraftModel(model)
        return
      }
      // Optimistic — reflect the pick immediately; the PATCH persists it (or reverts via reload on failure).
      setSessions((prev) =>
        prev.map((s) => (s.id === activeId ? { ...s, model: model ?? undefined } : s))
      )
      try {
        const res = await fetch(`/api/agent/sessions/${encodeURIComponent(activeId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model }),
        })
        if (!res.ok) throw new Error('patch failed')
      } catch {
        toast.error(t('errorGeneric'))
        void loadSessions()
      }
    },
    [activeId, loadSessions, t]
  )

  const changePermissionMode = useCallback(
    async (mode: AgentPermissionMode) => {
      if (!activeId) {
        // A draft has no server session yet — hold it locally and send it with the create request on the first send.
        setDraftPermissionMode(mode)
        return
      }
      // Optimistic — reflect the pick immediately; the PATCH persists it ("default" clears the standing mode).
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeId ? { ...s, permissionMode: mode === 'default' ? undefined : mode } : s
        )
      )
      try {
        const res = await fetch(`/api/agent/sessions/${encodeURIComponent(activeId)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ permissionMode: mode === 'default' ? null : mode }),
        })
        if (!res.ok) throw new Error('patch failed')
      } catch {
        toast.error(t('errorGeneric'))
        void loadSessions()
      }
    },
    [activeId, loadSessions, t]
  )

  // Retire ONE optimistic bubble (just one, when several share the content) — consecutive redirects can carry the same sentence twice.
  const dropPending = useCallback((text: string) => {
    setPendingUsers((prev) => {
      const i = prev.findIndex((p) => p.text === text)
      return i < 0 ? prev : prev.filter((_, j) => j !== i)
    })
  }, [])

  // Live streaming buffers: the SOURCE accumulates in a ref, and the visible state flushes at most once per
  // animation frame. SSE chunks arrive far more often than the display refreshes, and every visible update
  // re-parses the whole in-flight markdown bubble — per-chunk setState made a long answer pay O(length) parse
  // work at chunk rate (on top of a re-render of the panel), which is what dragged as conversations grew.
  const liveStreamRef = useRef({ text: '', reasoning: '' })
  const streamFlushRef = useRef<number | null>(null)
  const flushStreaming = useCallback(() => {
    streamFlushRef.current = null
    setStreamingText(liveStreamRef.current.text)
    setStreamingReasoning(liveStreamRef.current.reasoning)
  }, [])
  const scheduleStreamFlush = useCallback(() => {
    if (streamFlushRef.current === null)
      streamFlushRef.current = requestAnimationFrame(flushStreaming)
  }, [flushStreaming])
  // Zero the buffers AND the visible state together — a frame flush still pending after this is harmless
  // (it re-applies the now-empty buffers).
  const resetStreaming = useCallback(() => {
    if (streamFlushRef.current !== null) {
      cancelAnimationFrame(streamFlushRef.current)
      streamFlushRef.current = null
    }
    liveStreamRef.current = { text: '', reasoning: '' }
    setStreamingText('')
    setStreamingReasoning('')
  }, [])
  useEffect(
    () => () => {
      if (streamFlushRef.current !== null) cancelAnimationFrame(streamFlushRef.current)
    },
    []
  )

  // Apply one SSE event: a text delta grows the live assistant bubble; a persisted record merges into the
  // transcript (and, for the finalized assistant text, retires the live bubble); a `permission` event parks a
  // write-tool approval the member must decide, and `permission_resolved` dismisses it (e.g. server timeout).
  // Shared verbatim by the send stream and the re-attach stream — one event vocabulary, one reducer.
  const applyStreamEvent = useCallback(
    (event: string, data: unknown) => {
      if (event === 'delta') {
        const delta =
          data !== null && typeof data === 'object' && 'text' in data
            ? (data as { text?: unknown }).text
            : undefined
        if (typeof delta === 'string' && delta.length > 0) {
          liveStreamRef.current.text += delta
          scheduleStreamFlush()
        }
        setStreamNotice(null) // progress — the retry wait is over
      } else if (event === 'reasoning') {
        // Live extended-thinking tokens — grow the in-flight reasoning block until this turn's record lands.
        const delta =
          data !== null && typeof data === 'object' && 'text' in data
            ? (data as { text?: unknown }).text
            : undefined
        if (typeof delta === 'string' && delta.length > 0) {
          liveStreamRef.current.reasoning += delta
          scheduleStreamFlush()
        }
        setStreamNotice(null)
      } else if (event === 'message') {
        const parsed = agentMessageSchema.safeParse(data)
        if (!parsed.success) return
        setMessages((prev) => mergeMessages(prev, [parsed.data]))
        setStreamNotice(null)
        // An optimistic bubble is retired only when the record FOR THAT CONTENT arrives — teammate messages and platform events also
        // come in with the user role, so retiring on any user record makes what I sent disappear from the screen.
        if (parsed.data.role === 'user') dropPending(parsed.data.content)
        // Each assistant record carries this turn's finalized reasoning + text, so retire the live buffers when it lands.
        if (parsed.data.role === 'assistant') {
          liveStreamRef.current.reasoning = ''
          setStreamingReasoning('')
          if (parsed.data.content.trim().length > 0) {
            liveStreamRef.current.text = ''
            setStreamingText('')
          }
        }
      } else if (event === 'retry') {
        // The loop is waiting out transient trouble — a banner for why the turn is quiet. The newest attempt replaces the previous banner.
        if (data !== null && typeof data === 'object' && 'attempt' in data && 'delayMs' in data) {
          const d = data as { attempt?: unknown; delayMs?: unknown; persistent?: unknown }
          if (typeof d.attempt === 'number' && typeof d.delayMs === 'number')
            setStreamNotice({
              kind: 'retry',
              attempt: d.attempt,
              delayMs: d.delayMs,
              ...(d.persistent === true ? { persistent: true } : {}),
            })
        }
      } else if (event === 'fallback') {
        // Switched to the fallback model — a one-line notice (the next progress event clears it).
        const to =
          data !== null && typeof data === 'object' && 'to' in data
            ? (data as { to?: unknown }).to
            : undefined
        if (typeof to === 'string' && to.length > 0) setStreamNotice({ kind: 'fallback', to })
      } else if (event === 'view_config') {
        // The agent drove the analysis canvas (apply_view_config) — same-window broadcast; the analyze
        // dashboard / open View listens and applies the stored-form config live.
        if (data !== null && typeof data === 'object')
          window.dispatchEvent(new CustomEvent('everdict:view-config', { detail: data }))
      } else if (event === 'agent_draft') {
        // The agent shaped a crafting canvas (craft_agent) — a same-window broadcast; the studio applies it.
        if (data !== null && typeof data === 'object')
          window.dispatchEvent(new CustomEvent('everdict:agent-draft', { detail: data }))
      } else if (event === 'artifact') {
        // A chart/table/report the agent just emitted — render it live in place.
        const parsed = analysisArtifactSchema.safeParse(data)
        if (parsed.success)
          setArtifacts((prev) =>
            prev.some((a) => a.id === parsed.data.id) ? prev : [...prev, parsed.data]
          )
      } else if (event === 'permission') {
        if (data !== null && typeof data === 'object' && 'requestId' in data && 'name' in data) {
          const d = data as { requestId?: unknown; name?: unknown; input?: unknown }
          const requestId = d.requestId
          const name = d.name
          // A re-attached stream REPLAYS pending approvals, so duplicates are filtered by requestId and the prompt does not appear twice.
          if (typeof requestId === 'string' && typeof name === 'string')
            setPendingPermissions((prev) =>
              prev.some((p) => p.requestId === requestId)
                ? prev
                : [...prev, { requestId, name, input: d.input }]
            )
        }
      } else if (event === 'error') {
        // The turn failed. Usually the reason also lands as an assistant record (that is the transcript's job), but a turn that died
        // BEFORE reaching the loop (model resolution failure, tool session failure) has no record — then this toast is the only signal.
        const detail =
          data !== null && typeof data === 'object' && 'message' in data
            ? (data as { message?: unknown }).message
            : undefined
        setStreamNotice(null)
        toast.error(typeof detail === 'string' && detail.length > 0 ? detail : t('errorTurn'))
      } else if (event === 'permission_resolved') {
        // The server decided it (a timeout/disconnect default, not a click) — drop the first prompt for that tool.
        const name =
          data !== null && typeof data === 'object' && 'name' in data
            ? (data as { name?: unknown }).name
            : undefined
        if (typeof name === 'string')
          setPendingPermissions((prev) => {
            const i = prev.findIndex((p) => p.name === name)
            return i < 0 ? prev : prev.filter((_, j) => j !== i)
          })
      }
    },
    [t, dropPending, scheduleStreamFlush]
  )

  // Stream ownership token: incremented every time a send/re-attach reader starts. A finished (or broken) reader only touches state
  // in its own cleanup while it is still the newest owner — this is what stops a stale `finally` clearing a new stream's sending flag.
  const streamSeqRef = useRef(0)
  // Incremented every time one stream is cleaned up — the re-run trigger for the re-attach effect (a 204 check after a turn ends, recovery from a network drop).
  const [attachEpoch, setAttachEpoch] = useState(0)

  // Reconcile the screen with the transcript the server actually HAS for this conversation. A stream can break at any moment from a
  // cancel or a network drop, and at that moment records the server already persisted may not have reached us — without reconciling,
  // those disappear from the screen permanently and then reappear mid-list the next time the conversation is opened (a corrupted list).
  const reconcileMessages = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages`, {
        cache: 'no-store',
      })
      if (!res.ok) return
      const parsed = agentMessageListSchema.safeParse(await res.json())
      if (parsed.success && activeIdRef.current === sessionId)
        setMessages((prev) => mergeMessages(prev, parsed.data.messages))
    } catch {
      // silent — the next settle reconciles again
    }
  }, [])

  // The shared cleanup for one stream (send or re-attach) finishing. It also refreshes the entities the turn created (View/schedule/teammate).
  const settleStream = useCallback(
    (seq: number, sessionId: string | null) => {
      if (streamSeqRef.current !== seq) return
      abortRef.current = null
      resetStreaming()
      setStreamNotice(null)
      setPendingUsers([])
      setSending(false)
      // The turn is over; any approval still parked was denied server-side (timeout/stop), so clear the strip.
      setPendingPermissions([])
      if (sessionId !== null) void reconcileMessages(sessionId)
      void loadSessions()
      void loadTeammates()
      refresh()
      setAttachEpoch((e) => e + 1)
    },
    [loadSessions, loadTeammates, reconcileMessages, resetStreaming, router]
  )

  const send = useCallback(
    async (textArg?: string, refsArg?: AgentReference[]) => {
      const text = (textArg ?? input).trim()
      if (text.length === 0) return
      // A sent prompt enters the composer's ↑ history (Claude Code's global history). Keeping it even when the send FAILED is the better
      // default — a failed prompt is exactly the one you reach for again.
      pushPromptHistory(text)
      // A send into a running turn is a REDIRECT (queue-then-interrupt — a reinterpretation of Claude Code's ESC): the message is queued
      // into the running turn's mailbox and only the current step is cut — the loop stays alive, absorbs the message at the next boundary
      // and changes direction. Chips (references/attachments) need the whole chat pipeline, so they cannot ride a redirect — Stop, then resend.
      if (sending) {
        if (!activeId || textArg !== undefined) return
        if (references.length > 0 || attachments.length > 0) {
          toast.error(t('redirectNoContext'))
          return
        }
        const target = activeId
        setInput('')
        setPendingUsers((prev) => [...prev, { text, queued: true }])
        try {
          // An atomic redirect: the server checks liveness and queues+cuts in one — racing the turn's end queues NOTHING and answers 404
          // (no orphaned mailbox message) → restore the input and say to resend.
          const r = await fetch(`/api/agent/sessions/${encodeURIComponent(target)}/interrupt`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: text }),
          })
          if (r.status === 404) {
            setInput(text)
            dropPending(text)
            toast.error(t('redirectMissed'))
            return
          }
          if (!r.ok) throw new Error('interrupt failed')
        } catch {
          setInput(text)
          dropPending(text)
          toast.error(t('errorSend'))
        }
        return
      }

      // A draft's first send — only now is the server session created (carrying the model and permission mode chosen in the draft).
      let sessionId = activeId
      if (!sessionId) {
        try {
          const res = await fetch('/api/agent/sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ...(draftModel !== null ? { model: draftModel } : {}),
              ...(draftPermissionMode !== 'default' ? { permissionMode: draftPermissionMode } : {}),
            }),
          })
          if (!res.ok) throw new Error('create failed')
          const parsed = agentSessionSchema.safeParse(await res.json())
          if (!parsed.success) throw new Error('create failed')
          setSessions((prev) => [parsed.data, ...prev])
          setActiveId(parsed.data.id)
          setDraftModel(null)
          setDraftPermissionMode('default')
          sessionId = parsed.data.id
        } catch {
          toast.error(t('errorGeneric'))
          return
        }
      }

      const refs = refsArg ?? references
      const fromComposer = textArg === undefined
      const atts = fromComposer ? attachments : []
      if (fromComposer) {
        setInput('')
        setReferences([])
        setAttachments([])
      }
      // THIS send owns the stream — any open re-attach reader is torn down (the turn continues on the server) and the ownership token is
      // raised so a stale cleanup cannot clear this send's state.
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const seq = ++streamSeqRef.current

      setSending(true)
      setPendingUsers((prev) => [...prev, { text, queued: false }])
      resetStreaming()

      // Ask the analysis canvas (analyze dashboard / open View, same window) what it CURRENTLY shows — a
      // synchronous request/response round-trip, so every turn grounds on the live stored-form config
      // including the member's manual picker changes. No canvas mounted → no listener answers → undefined.
      let canvas: { config: Record<string, string>; viewId?: string } | undefined
      const captureCanvas = (e: Event) => {
        const detail = (e as CustomEvent<unknown>).detail
        if (detail === null || typeof detail !== 'object') return
        const d = detail as { config?: unknown; viewId?: unknown }
        if (d.config === null || typeof d.config !== 'object') return
        const entries = Object.entries(d.config as Record<string, unknown>).filter(
          (pair): pair is [string, string] => typeof pair[1] === 'string'
        )
        canvas = {
          config: Object.fromEntries(entries),
          ...(typeof d.viewId === 'string' ? { viewId: d.viewId } : {}),
        }
      }
      window.addEventListener('everdict:canvas-state', captureCanvas)
      window.dispatchEvent(new Event('everdict:canvas-state-request'))
      window.removeEventListener('everdict:canvas-state', captureCanvas)

      // The crafting canvas has the same contract (agent-automation B2/B3): while open, the current draft is captured just before sending,
      // so every turn rests on the live state INCLUDING manual edits. No canvas → no answer → undefined.
      let agentDraft: { draft: Record<string, unknown>; agentId?: string } | undefined
      const captureDraft = (e: Event) => {
        const detail = (e as CustomEvent<unknown>).detail
        if (detail === null || typeof detail !== 'object') return
        const d = detail as { draft?: unknown; agentId?: unknown }
        if (d.draft === null || typeof d.draft !== 'object') return
        agentDraft = {
          draft: d.draft as Record<string, unknown>,
          ...(typeof d.agentId === 'string' ? { agentId: d.agentId } : {}),
        }
      }
      window.addEventListener('everdict:agent-draft-state', captureDraft)
      window.dispatchEvent(new Event('everdict:agent-draft-request'))
      window.removeEventListener('everdict:agent-draft-state', captureDraft)

      try {
        const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({
            message: text,
            ...(refs.length > 0 ? { references: refs } : {}),
            ...(atts.length > 0 ? { attachments: atts } : {}),
            ...(canvas ? { canvas } : {}),
            ...(agentDraft ? { agentDraft } : {}),
          }),
          signal: controller.signal,
        })
        if (res.status === 409) {
          // A turn is already running in this conversation (another tab, a session returned to) — re-attach instead of running twice: the
          // input is handed back, and after settleStream the re-attach effect binds to the stream in progress.
          if (fromComposer) setInput(text)
          toast.info(t('errorBusy'))
          return
        }
        if (!res.ok || !res.body) throw new Error('chat failed')
        if ((res.headers.get('content-type') ?? '').includes('application/json')) {
          const parsed = agentMessageListSchema.safeParse(await res.json())
          if (parsed.success) setMessages((prev) => mergeMessages(prev, parsed.data.messages))
        } else {
          await readSseStream(res.body, applyStreamEvent)
        }
      } catch {
        if (!controller.signal.aborted) {
          if (fromComposer) setInput(text)
          toast.error(t('errorSend'))
        }
      } finally {
        settleStream(seq, sessionId)
      }
    },
    [
      input,
      activeId,
      sending,
      references,
      attachments,
      draftModel,
      draftPermissionMode,
      applyStreamEvent,
      dropPending,
      resetStreaming,
      settleStream,
      t,
    ]
  )

  const addReference = useCallback((r: AgentReference) => {
    setReferences((prev) =>
      prev.some((x) => x.type === r.type && x.id === r.id) ? prev : [...prev, r]
    )
  }, [])

  // A detail page asked to analyze its entity here — drop the reference chip into the composer and/or pre-type
  // the draft prompt, then clear the buffer so a later tab re-mount (the agent tab unmounts when another infra
  // tab is shown) does not re-inject the same prefill. A prompt overwrites only an empty composer — never a
  // member's in-progress draft.
  // Whether to start in a NEW conversation is the entry's decision (startsFreshConversation): an edit mission always does, analyze/ask only
  // when the entry declared `fresh` — the flow of comparing two scorecards in one conversation is kept by default, and only entries whose
  // subject IS that one record (an issue detail, an empty analysis canvas) opt out. Mission framing appears only on an empty screen, so this
  // decision IS "do you get a panel framed for the work every time you enter".
  useEffect(() => {
    if (!pendingMention) return
    if (startsFreshConversation(pendingMention) && activeId !== null) newConversation()
    if (pendingMention.ref) addReference(pendingMention.ref)
    if (pendingMention.prompt)
      setInput((prev) => (prev.trim().length > 0 ? prev : (pendingMention.prompt ?? '')))
    if (pendingMention.mission)
      setMission({
        kind: pendingMention.mission,
        ...(pendingMention.ref ? { target: pendingMention.ref.label } : {}),
      })
    onConsumeMention?.()
  }, [pendingMention, addReference, onConsumeMention, activeId, newConversation])

  // A comment thread asked to open its discussion session — switch to it in WATCH mode. The session is
  // workspace-visible but not necessarily in the caller's own list (it belongs to the first asker), so fetch the
  // record and merge it for the header/title. Consume so a tab re-mount does not re-open it.
  useEffect(() => {
    if (!pendingSession) return
    const id = pendingSession.id
    onConsumeSession?.()
    if (id !== activeId) switchTo(id)
    setWatchId(id)
    void (async () => {
      try {
        const res = await fetch(`/api/agent/sessions/${encodeURIComponent(id)}`, {
          cache: 'no-store',
        })
        if (!res.ok) return
        const parsed = agentSessionSchema.safeParse(await res.json())
        if (parsed.success)
          setSessions((prev) =>
            prev.some((s) => s.id === parsed.data.id) ? prev : [parsed.data, ...prev]
          )
      } catch {
        // silent — the transcript still renders; the header shows the fallback title
      }
    })()
  }, [pendingSession, onConsumeSession, activeId, switchTo])

  // The transcript's newest seq — the ?since= cursor for watch polling (refreshed on every message merge).
  useEffect(() => {
    maxSeqRef.current = messages.reduce((max, m) => (m.seq > max ? m.seq : max), -1)
  }, [messages])

  // Watch polling: while the watched session is active and we are not streaming a turn of our own, pull the
  // incrementally-persisted transcript (runChat persists each record as the loop produces it) + the parked
  // write-tool approvals a background discussion turn is awaiting. Cheap when idle (since-cursor, empty lists).
  useEffect(() => {
    if (!watchId || watchId !== activeId) return
    let cancelled = false
    const tick = async () => {
      if (cancelled || sending) return
      try {
        const since = maxSeqRef.current
        const res = await fetch(
          `/api/agent/sessions/${encodeURIComponent(watchId)}/messages${since >= 0 ? `?since=${since}` : ''}`,
          { cache: 'no-store' }
        )
        if (res.ok) {
          const parsed = agentMessageListSchema.safeParse(await res.json())
          if (!cancelled && parsed.success && parsed.data.messages.length > 0)
            setMessages((prev) => mergeMessages(prev, parsed.data.messages))
        }
      } catch {
        // silent — retried on the next tick
      }
      try {
        const res = await fetch(`/api/agent/sessions/${encodeURIComponent(watchId)}/pending`, {
          cache: 'no-store',
        })
        if (res.ok) {
          const data = (await res.json()) as {
            pending?: { requestId?: unknown; name?: unknown; input?: unknown }[]
          }
          if (!cancelled && Array.isArray(data.pending))
            setPendingPermissions(
              data.pending
                .filter(
                  (p): p is { requestId: string; name: string; input: unknown } =>
                    typeof p.requestId === 'string' && typeof p.name === 'string'
                )
                .map((p) => ({ requestId: p.requestId, name: p.name, input: p.input }))
            )
        }
      } catch {
        // silent — retried on the next tick
      }
    }
    void tick()
    const interval = setInterval(() => void tick(), 2000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [watchId, activeId, sending])

  // If the open conversation has a LIVE turn, re-attach to its stream — a session left and returned to, a turn started in another tab, a turn
  // whose stream alone was lost to a network drop (the turn keeps running on the server). 204 = nothing in progress → quietly idle. While
  // attaching it shows as sending so the composer keeps the streaming state (Stop included). attachEpoch triggers a re-run every time one stream
  // is cleaned up (after a turn ends that is a cheap round trip ending in a 204). Ownership is checked through abortRef —
  // it does not attach when a send already holds the reader (consuming the same feed twice applies every delta twice).
  useEffect(() => {
    void attachEpoch // used purely as a re-run trigger (the value itself means nothing)
    if (!activeId || abortRef.current) return
    // Do not attach to a turn that was just explicitly stopped: the server closes the turn slot only after the loop unwinds, so a GET /stream in
    // between still answers 200 and REPLAYS the partial answer just cancelled — that is the flicker where cancelled content comes back and
    // disappears. Skipped exactly once (moving conversation resets it through switchTo).
    if (suppressAttachRef.current) {
      suppressAttachRef.current = false
      return
    }
    const id = activeId
    const controller = new AbortController()
    void (async () => {
      let seq: number | null = null
      try {
        const res = await fetch(`/api/agent/sessions/${encodeURIComponent(id)}/stream`, {
          headers: { accept: 'text/event-stream' },
          cache: 'no-store',
          signal: controller.signal,
        })
        if (res.status !== 200 || !res.body || controller.signal.aborted || abortRef.current) return
        abortRef.current = controller
        seq = ++streamSeqRef.current
        setSending(true)
        resetStreaming()
        await readSseStream(res.body, applyStreamEvent)
        // A record can land between the initial transcript load and the stream subscription — merge the tail once more to close that
        // window (merging by id, so duplicates are harmless).
        if (!controller.signal.aborted) {
          const tail = await fetch(`/api/agent/sessions/${encodeURIComponent(id)}/messages`, {
            cache: 'no-store',
          })
          if (tail.ok && !controller.signal.aborted) {
            const parsed = agentMessageListSchema.safeParse(await tail.json())
            if (parsed.success) setMessages((prev) => mergeMessages(prev, parsed.data.messages))
          }
        }
      } catch {
        // aborted (session switch, send start, unmount) or network — the next re-run tries again
      } finally {
        if (seq !== null) settleStream(seq, id)
      }
    })()
    return () => controller.abort()
  }, [activeId, attachEpoch, applyStreamEvent, resetStreaming, settleStream])

  // Stop = an explicit server abort (POST /stop). Dropping the connection no longer stops a turn (the turn was decoupled from the connection)
  // — when the server aborts the loop, a terminal event closes our stream and settleStream cleans up. Even when the request fails the local
  // reader is torn down (404 = a turn that already ended, harmless).
  const stop = useCallback(() => {
    const id = activeId
    if (!id) {
      abortRef.current?.abort()
      return
    }
    suppressAttachRef.current = true
    void fetch(`/api/agent/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' })
      .then(async (res) => {
        if (!res.ok) return
        // The server hands back a message that was queued by a redirect and that the loop never absorbed — it goes back into the composer
        // (Claude Code's "Esc returns the queue to the input"). Otherwise that sentence is gone from the transcript AND the input.
        // Anything already being typed is not overwritten.
        const data = (await res.json()) as { dropped?: unknown }
        const dropped = Array.isArray(data.dropped)
          ? data.dropped.filter((d): d is string => typeof d === 'string' && d.length > 0)
          : []
        if (dropped.length > 0)
          setInput((prev) => (prev.trim().length > 0 ? prev : dropped.join('\n\n')))
      })
      .catch(() => {
        // silent — the local abort below still frees the UI
      })
      .finally(() => abortRef.current?.abort())
  }, [activeId])

  const decidePermission = useCallback(
    (requestId: string, decision: 'allow' | 'deny') => {
      setPendingPermissions((prev) => prev.filter((p) => p.requestId !== requestId))
      if (!activeId) return
      // Fire-and-forget: if this fails, the server-side timeout denies it anyway, so we don't block the UI on it.
      void fetch(`/api/agent/sessions/${encodeURIComponent(activeId)}/permission`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId, decision }),
      }).catch(() => {
        // silent — the loop's pending approval falls back to deny on timeout
      })
    },
    [activeId]
  )

  const active = activeId ? sessions.find((s) => s.id === activeId) : undefined
  return (
    <ConversationView
      workspace={workspace}
      title={active?.title ?? t('new')}
      user={user}
      mission={mission}
      canvasLink={canvasLink}
      models={modelIds}
      model={activeId ? (active?.model ?? null) : draftModel}
      onChangeModel={(m) => void changeModel(m)}
      permissionMode={activeId ? (active?.permissionMode ?? 'default') : draftPermissionMode}
      onChangePermissionMode={(m) => void changePermissionMode(m)}
      sessions={sessions}
      activeId={activeId}
      onOpenSession={openSession}
      onNewConversation={newConversation}
      onDeleteSession={(id) => void deleteSession(id)}
      onRenameSession={(id, title) => void renameSession(id, title)}
      teammates={teammates}
      onSpawnTeammate={(spawnInput) => void spawnTeammate(spawnInput)}
      onStopTeammate={(id) => void stopTeammate(id)}
      messages={messages}
      artifacts={artifacts}
      pendingUsers={pendingUsers}
      sending={sending}
      streamingText={streamingText}
      streamingReasoning={streamingReasoning}
      streamNotice={streamNotice}
      input={input}
      references={references}
      attachments={attachments}
      onChange={setInput}
      onSend={() => void send()}
      onStop={stop}
      onPickReference={addReference}
      onRemoveReference={(i) => setReferences((prev) => prev.filter((_, j) => j !== i))}
      onPickAttachment={(a) => setAttachments((prev) => [...prev, a])}
      onRemoveAttachment={(i) => setAttachments((prev) => prev.filter((_, j) => j !== i))}
      onSuggestion={(txt) => void send(txt)}
      pendingPermissions={pendingPermissions}
      onDecidePermission={decidePermission}
    />
  )
}
