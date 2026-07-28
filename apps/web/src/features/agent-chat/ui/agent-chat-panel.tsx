'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import {
  agentMessageListSchema,
  agentMessageSchema,
  agentSessionListSchema,
  agentSessionSchema,
  agentTeammateListSchema,
  type AgentAttachmentInput,
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

import { ConversationView } from './conversation-view'
import type { ChatUser } from './message-row'
import type { PendingPermission } from './permission-prompt'
import type { TeammateSpawnInput } from './team-menu'

// The agent conversation surface for the infra panel's "agent" tab. Owns all state + I/O; delegates rendering to
// ConversationView (the chat is ALWAYS on screen — entering the tab lands on a ready-to-type draft, and history
// lives in the header's SessionMenu dropdown, so the user never leaves the chat). A draft (activeId === null) has
// no server session yet; the first send creates one lazily (so opening the tab never litters empty sessions).
// Talks only to the same-origin BFF (/api/agent/*). A turn streams over SSE: `delta` events grow the live
// assistant bubble, `message` events merge each persisted record (so tool cards + the finalized answer appear
// live); the Stop button aborts the request → the server aborts the loop.

function mergeMessages(prev: AgentMessage[], incoming: AgentMessage[]): AgentMessage[] {
  const byId = new Map(prev.map((m) => [m.id, m]))
  for (const m of incoming) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

// pendingMention (+ onConsumeMention) is threaded down from the infra panel: an entity detail page asked to
// analyze its entity here, so drop it into the composer as a reference chip and/or pre-type a draft prompt
// (nothing auto-sends — the member reviews and presses send). The prop shape is declared inline (not imported
// from the widget) to keep the FSD import direction downward-only.
export function AgentChatPanel({
  pendingMention,
  onConsumeMention,
  user,
}: {
  pendingMention?: { ref?: AgentReference; prompt?: string } | null
  onConsumeMention?: () => void
  user?: ChatUser
} = {}) {
  const t = useTranslations('agentChat')
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  // Emitted analysis artifacts (charts/tables/reports) — hydrated per session, appended live via SSE `artifact`.
  const [artifacts, setArtifacts] = useState<AnalysisArtifact[]>([])
  const [pendingUser, setPendingUser] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [references, setReferences] = useState<AgentReference[]>([])
  const [attachments, setAttachments] = useState<AgentAttachmentInput[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [streamingReasoning, setStreamingReasoning] = useState('')
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([])
  const [modelIds, setModelIds] = useState<string[]>([])
  // 드래프트(세션 미생성) 상태에서 고른 모델 — 첫 전송의 세션 생성에 실려 간다.
  const [draftModel, setDraftModel] = useState<string | null>(null)
  // 드래프트에서 고른 실행 권한 모드 — 'default'(항상 확인)가 기본이라 기본값이면 생성 요청에 싣지 않는다.
  const [draftPermissionMode, setDraftPermissionMode] = useState<AgentPermissionMode>('default')
  // The caller's live teammates (docs/architecture/agent-teams.md) — long-lived autonomous agents that watch platform
  // events and wake to react. Loaded on mount and refreshed after each turn (the agent can self-spawn via a tool).
  const [teammates, setTeammates] = useState<AgentTeammate[]>([])
  const abortRef = useRef<AbortController | null>(null)

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
        // 병합(교체 아님): 전환 시엔 이미 비워져 있고, 첫 전송이 방금 만든 세션이면 스트리밍으로 먼저
        // 도착한 레코드를 빈 서버 응답이 덮어쓰면 안 된다.
        if (!cancelled && parsed.success)
          setMessages((prev) => mergeMessages(prev, parsed.data.messages))
      } catch {
        // silent
      }
    })()
    // 이 대화의 분석 아티팩트(차트/표/리포트) — 트랜스크립트에 시간순으로 끼워 렌더된다.
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

  // 진행 중 턴을 끊고 다른 대화로 컨텍스트를 전환한다 — 이전 세션의 스트림이 새 화면에 섞이지 않게.
  const switchTo = useCallback((id: string | null) => {
    abortRef.current?.abort()
    setActiveId(id)
    setMessages([])
    setArtifacts([])
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
        // 드래프트엔 아직 서버 세션이 없다 — 로컬에 들고 있다가 첫 전송의 생성 요청에 싣는다.
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
        // 드래프트엔 아직 서버 세션이 없다 — 로컬에 들고 있다가 첫 전송의 생성 요청에 싣는다.
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

  const send = useCallback(
    async (textArg?: string, refsArg?: AgentReference[]) => {
      const text = (textArg ?? input).trim()
      if (text.length === 0 || sending) return

      // 드래프트의 첫 전송 — 이제서야 서버 세션을 만든다(드래프트에서 고른 모델·실행 권한 모드를 실어서).
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
      setSending(true)
      setPendingUser(text)
      setStreamingText('')
      setStreamingReasoning('')

      const controller = new AbortController()
      abortRef.current = controller

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

      // Apply one SSE event: a text delta grows the live assistant bubble; a persisted record merges into the
      // transcript (and, for the finalized assistant text, retires the live bubble); a `permission` event parks a
      // write-tool approval the member must decide, and `permission_resolved` dismisses it (e.g. server timeout).
      const handleEvent = (event: string, data: unknown) => {
        if (event === 'delta') {
          const delta =
            data !== null && typeof data === 'object' && 'text' in data
              ? (data as { text?: unknown }).text
              : undefined
          if (typeof delta === 'string' && delta.length > 0)
            setStreamingText((prev) => prev + delta)
        } else if (event === 'reasoning') {
          // Live extended-thinking tokens — grow the in-flight reasoning block until this turn's record lands.
          const delta =
            data !== null && typeof data === 'object' && 'text' in data
              ? (data as { text?: unknown }).text
              : undefined
          if (typeof delta === 'string' && delta.length > 0)
            setStreamingReasoning((prev) => prev + delta)
        } else if (event === 'message') {
          const parsed = agentMessageSchema.safeParse(data)
          if (!parsed.success) return
          setMessages((prev) => mergeMessages(prev, [parsed.data]))
          if (parsed.data.role === 'user') setPendingUser(null)
          // Each assistant record carries this turn's finalized reasoning + text, so retire the live buffers when it lands.
          if (parsed.data.role === 'assistant') {
            setStreamingReasoning('')
            if (parsed.data.content.trim().length > 0) setStreamingText('')
          }
        } else if (event === 'view_config') {
          // The agent drove the analysis canvas (apply_view_config) — same-window broadcast; the analyze
          // dashboard / open View listens and applies the stored-form config live.
          if (data !== null && typeof data === 'object')
            window.dispatchEvent(new CustomEvent('everdict:view-config', { detail: data }))
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
            if (typeof d.requestId === 'string' && typeof d.name === 'string')
              setPendingPermissions((prev) => [
                ...prev,
                { requestId: d.requestId as string, name: d.name as string, input: d.input },
              ])
          }
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
      }

      try {
        const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({
            message: text,
            ...(refs.length > 0 ? { references: refs } : {}),
            ...(atts.length > 0 ? { attachments: atts } : {}),
            ...(canvas ? { canvas } : {}),
          }),
          signal: controller.signal,
        })
        if (!res.ok || !res.body) throw new Error('chat failed')
        if ((res.headers.get('content-type') ?? '').includes('application/json')) {
          const parsed = agentMessageListSchema.safeParse(await res.json())
          if (parsed.success) setMessages((prev) => mergeMessages(prev, parsed.data.messages))
        } else {
          const reader = res.body.getReader()
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
                  handleEvent(ev, JSON.parse(dataStr))
                } catch {
                  // skip a malformed frame
                }
              }
              boundary = buffer.indexOf('\n\n')
            }
          }
        }
      } catch {
        if (!controller.signal.aborted) {
          if (fromComposer) setInput(text)
          toast.error(t('errorSend'))
        }
      } finally {
        abortRef.current = null
        setStreamingText('')
        setStreamingReasoning('')
        setPendingUser(null)
        setSending(false)
        // The turn is over; any approval still parked was denied server-side (timeout/disconnect), so clear the strip.
        setPendingPermissions([])
        void loadSessions()
        // The turn may have self-spawned a teammate (spawn_teammate tool) — refresh the roster so the badge reflects it.
        void loadTeammates()
      }
    },
    [input, activeId, sending, references, attachments, draftModel, loadSessions, loadTeammates, t]
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
  useEffect(() => {
    if (!pendingMention) return
    if (pendingMention.ref) addReference(pendingMention.ref)
    if (pendingMention.prompt)
      setInput((prev) => (prev.trim().length > 0 ? prev : (pendingMention.prompt ?? '')))
    onConsumeMention?.()
  }, [pendingMention, addReference, onConsumeMention])

  const stop = useCallback(() => abortRef.current?.abort(), [])

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
      title={active?.title ?? t('new')}
      user={user}
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
      pendingUser={pendingUser}
      sending={sending}
      streamingText={streamingText}
      streamingReasoning={streamingReasoning}
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
