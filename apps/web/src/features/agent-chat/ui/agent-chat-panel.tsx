'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import {
  AGENT_CHAT_MISSION_INTENTS,
  agentMessageListSchema,
  agentMessageSchema,
  agentSessionListSchema,
  agentSessionSchema,
  agentTeammateListSchema,
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
// live). The turn OUTLIVES this connection — the agent server keeps the loop running when the client detaches —
// so switching conversations (or unmounting the tab) loses nothing: opening a session with a live turn
// re-attaches to its stream (GET /stream, sessions carry the computed `live` flag), a concurrent send is refused
// with 409 (re-attach instead of double-running), and Stop is the explicit POST /stop, not a dropped connection.

function mergeMessages(prev: AgentMessage[], incoming: AgentMessage[]): AgentMessage[] {
  const byId = new Map(prev.map((m) => [m.id, m]))
  for (const m of incoming) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

// 공용 SSE 프레임 리더 — 전송(POST /chat)과 재접속(GET /stream)이 같은 파서로 같은 이벤트 어휘를 소비한다.
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
// entry such as Settings › Skills 상세의 "대화로 편집하기" — which lands on a fresh draft and reframes the empty
// chat (title/body/suggestions) for that task; the surface itself is unchanged. pendingSession (+ onConsumeSession) is the same
// channel for a comment thread's "view details": open a SPECIFIC (workspace-visible discussion) session and WATCH
// it — a background turn streams its SSE to nobody, so the panel polls /messages?since= + /pending instead. The
// prop shapes are declared inline (not imported from the widget) to keep the FSD import direction downward-only.
export function AgentChatPanel({
  pendingMention,
  onConsumeMention,
  pendingSession,
  onConsumeSession,
  user,
}: {
  pendingMention?: { ref?: AgentReference; prompt?: string; mission?: AgentChatMission } | null
  onConsumeMention?: () => void
  pendingSession?: { id: string } | null
  onConsumeSession?: () => void
  user?: ChatUser
} = {}) {
  const t = useTranslations('agentChat')
  const router = useRouter()
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  // Emitted analysis artifacts (charts/tables/reports) — hydrated per session, appended live via SSE `artifact`.
  const [artifacts, setArtifacts] = useState<AnalysisArtifact[]>([])
  const [pendingUser, setPendingUser] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [references, setReferences] = useState<AgentReference[]>([])
  // 전용 진입으로 들어온 임무(스킬 편집 등) + 그 대상 이름 — 빈 대화의 문구·제안을 그 작업에 맞춘다.
  // 대상은 함께 떨어진 참조 칩에서 그대로 가져온다(추측 없음). 대화를 바꾸면 사라진다.
  const [mission, setMission] = useState<{ kind: AgentChatMission; target?: string } | null>(null)
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

  // 다른 대화로 컨텍스트를 전환한다 — 리더만 내려 이전 세션의 스트림이 새 화면에 섞이지 않게 한다. 턴 자체는
  // 서버에서 계속 돌고, 되돌아오면 재접속 효과가 라이브 스트림에 다시 붙는다.
  const switchTo = useCallback((id: string | null) => {
    abortRef.current?.abort()
    setActiveId(id)
    setMessages([])
    setArtifacts([])
    setWatchId(null) // 워치 모드는 열어 준 그 세션에만 한정 — 다른 대화로 가면 폴링 중단
    setPendingPermissions([])
    setMission(null) // 임무는 진입한 그 대화에만 붙는다
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

  // Apply one SSE event: a text delta grows the live assistant bubble; a persisted record merges into the
  // transcript (and, for the finalized assistant text, retires the live bubble); a `permission` event parks a
  // write-tool approval the member must decide, and `permission_resolved` dismisses it (e.g. server timeout).
  // Shared verbatim by the send stream and the re-attach stream — one event vocabulary, one reducer.
  const applyStreamEvent = useCallback((event: string, data: unknown) => {
    if (event === 'delta') {
      const delta =
        data !== null && typeof data === 'object' && 'text' in data
          ? (data as { text?: unknown }).text
          : undefined
      if (typeof delta === 'string' && delta.length > 0) setStreamingText((prev) => prev + delta)
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
    } else if (event === 'agent_draft') {
      // 에이전트가 크래프팅 캔버스를 빚었다(craft_agent) — 같은 창 브로드캐스트; 스튜디오가 적용한다.
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
        // 재접속 스트림은 대기 중 승인을 replay 하므로 requestId 로 중복을 걸러 프롬프트가 두 번 뜨지 않게 한다.
        if (typeof requestId === 'string' && typeof name === 'string')
          setPendingPermissions((prev) =>
            prev.some((p) => p.requestId === requestId)
              ? prev
              : [...prev, { requestId, name, input: d.input }]
          )
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
  }, [])

  // 스트림 소유권 토큰: 전송/재접속 리더가 시작될 때마다 증가. 끝난(또는 끊긴) 리더의 뒷정리는 자신이 아직
  // 최신 소유자일 때만 상태를 건드린다 — 낡은 finally 가 새 스트림의 sending 표시를 지우는 사고 방지.
  const streamSeqRef = useRef(0)
  // 스트림이 하나 정리될 때마다 증가 — 재접속 효과의 재실행 트리거(턴 종료 후 204 확인, 네트워크 단절 복구).
  const [attachEpoch, setAttachEpoch] = useState(0)

  // 스트림(전송/재접속) 하나가 끝났을 때의 공통 정리. 턴이 만든 엔티티(View/스케줄/팀원)까지 새로고침한다.
  const settleStream = useCallback(
    (seq: number) => {
      if (streamSeqRef.current !== seq) return
      abortRef.current = null
      setStreamingText('')
      setStreamingReasoning('')
      setPendingUser(null)
      setSending(false)
      // The turn is over; any approval still parked was denied server-side (timeout/stop), so clear the strip.
      setPendingPermissions([])
      void loadSessions()
      void loadTeammates()
      router.refresh()
      setAttachEpoch((e) => e + 1)
    },
    [loadSessions, loadTeammates, router]
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
      // 이 전송이 스트림 소유권을 가진다 — 열려 있던 재접속 리더는 내리고(턴은 서버에서 계속된다), 소유권
      // 토큰을 올려 낡은 뒷정리가 이 전송의 상태를 지우지 못하게 한다.
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      const seq = ++streamSeqRef.current

      setSending(true)
      setPendingUser(text)
      setStreamingText('')
      setStreamingReasoning('')

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

      // 크래프팅 캔버스도 같은 계약(agent-automation B2/B3): 열려 있으면 전송 직전 현 draft 를 캡처해
      // 매 턴이 수동 편집 포함 라이브 상태에 근거한다. 캔버스 없음 → 응답 없음 → undefined.
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
          // 이미 이 대화에서 턴이 실행 중(다른 탭·되돌아온 세션) — 중복 실행 대신 재접속한다: 입력은 돌려주고,
          // 정리(settleStream) 뒤 재접속 효과가 진행 중 스트림에 붙는다.
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
        settleStream(seq)
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
  // An EDIT-intent mission additionally lands on a fresh draft when a persisted conversation is open: the task
  // framing only shows on an empty chat, and an editing mission has no business continuing someone else's thread.
  // Analyze/ask missions keep the open thread — comparing two scorecards in one conversation must stay possible —
  // and their framing simply applies whenever the chat is (or next becomes) empty.
  useEffect(() => {
    if (!pendingMention) return
    if (
      pendingMention.mission &&
      AGENT_CHAT_MISSION_INTENTS[pendingMention.mission] === 'edit' &&
      activeId !== null
    )
      newConversation()
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

  // 트랜스크립트의 최신 seq — 워치 폴링의 ?since= 커서 (메시지 병합마다 갱신).
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

  // 열린 대화에 LIVE 턴이 있으면 그 스트림에 다시 붙는다 — 세션을 떠났다 돌아온 경우, 다른 탭에서 시작한 턴,
  // 네트워크 단절로 스트림만 잃은 턴(턴은 서버에서 계속 돈다). 204 = 진행 중 없음 → 조용히 idle. 붙는 동안은
  // sending 으로 표시해 컴포저가 스트리밍 상태(Stop 포함)를 그대로 보여 준다. attachEpoch 는 스트림 하나가
  // 정리될 때마다 재실행을 트리거한다(턴 종료 뒤엔 204 확인으로 끝나는 값싼 왕복). 소유권 확인은 abortRef —
  // 전송이 이미 리더를 잡고 있으면 붙지 않는다(같은 피드를 이중 소비하면 델타가 두 번 적용된다).
  useEffect(() => {
    void attachEpoch // 재실행 트리거로만 쓰인다(값 자체는 의미 없음)
    if (!activeId || abortRef.current) return
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
        setStreamingText('')
        setStreamingReasoning('')
        await readSseStream(res.body, applyStreamEvent)
        // 최초 트랜스크립트 로드와 스트림 구독 사이에 영속된 레코드가 낄 수 있다 — 꼬리를 한 번 더 병합해
        // 닫는다(id 병합이라 중복 무해).
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
        // aborted(세션 전환·전송 시작·언마운트) 또는 네트워크 — 다음 재실행에서 다시 시도한다
      } finally {
        if (seq !== null) settleStream(seq)
      }
    })()
    return () => controller.abort()
  }, [activeId, attachEpoch, applyStreamEvent, settleStream])

  // Stop = 명시적 서버 중단(POST /stop). 연결을 끊는 것으로는 더 이상 턴이 멈추지 않는다(턴은 연결과 분리됐다)
  // — 서버가 루프를 abort 하면 터미널 이벤트가 우리 스트림을 닫고 settleStream 이 정리한다. 요청이 실패해도
  // 로컬 리더는 내린다(404 = 이미 끝난 턴, 무해).
  const stop = useCallback(() => {
    const id = activeId
    if (!id) {
      abortRef.current?.abort()
      return
    }
    void fetch(`/api/agent/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' })
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
