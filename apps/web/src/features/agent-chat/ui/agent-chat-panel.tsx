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
  // 보냈지만 아직 서버 레코드로 되돌아오지 않은 내 메시지들. `queued` 는 실행 중인 턴에 끼워 넣은(리다이렉트)
  // 것이라 진행 중인 답변 "아래"에 놓여야 한다 — 첫 전송은 답변보다 앞이다. 하나가 아니라 목록인 이유는
  // 연속 리다이렉트가 실제로 가능하기 때문(단일 슬롯이면 앞의 것이 화면에서 사라진다).
  const [pendingUsers, setPendingUsers] = useState<PendingUserMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [references, setReferences] = useState<AgentReference[]>([])
  // 전용 진입으로 들어온 임무(스킬 편집 등) + 그 대상 이름 — 빈 대화의 문구·제안을 그 작업에 맞춘다.
  // 대상은 함께 떨어진 참조 칩에서 그대로 가져온다(추측 없음). 대화를 바꾸면 사라진다.
  const [mission, setMission] = useState<{ kind: AgentChatMission; target?: string } | null>(null)
  const [attachments, setAttachments] = useState<AgentAttachmentInput[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [streamingReasoning, setStreamingReasoning] = useState('')
  // 일시 장애 배너: 루프가 모델 실패를 재시도 대기 중(`retry`)이거나 예비 모델로 전환(`fallback`)했음을
  // 알린다 — 없으면 긴 대기가 "얼어붙은 패널"로 보인다. 진행 이벤트(delta/reasoning/message)가 지운다.
  const [streamNotice, setStreamNotice] = useState<
    | { kind: 'retry'; attempt: number; delayMs: number; persistent?: boolean }
    | { kind: 'fallback'; to: string }
    | null
  >(null)
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
  // 스트림이 정착할 때 어느 대화의 트랜스크립트를 다시 맞출지 판정하는 기준 — 그 사이 대화를 옮겼다면
  // 남의 트랜스크립트를 섞지 않는다.
  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = activeId
  // 명시적으로 멈춘 직후의 재접속 한 번을 건너뛴다(stop 참고).
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
    suppressAttachRef.current = false // 중단 억제는 그 대화에만 한정 — 새 대화는 정상 재접속한다
    setActiveId(id)
    setMessages([])
    setPendingUsers([])
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

  // 낙관적 버블 하나를 걷는다(같은 내용이 여러 개면 하나만) — 연속 리다이렉트가 같은 문장을 두 번 담을 수 있다.
  const dropPending = useCallback((text: string) => {
    setPendingUsers((prev) => {
      const i = prev.findIndex((p) => p.text === text)
      return i < 0 ? prev : prev.filter((_, j) => j !== i)
    })
  }, [])

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
        if (typeof delta === 'string' && delta.length > 0) setStreamingText((prev) => prev + delta)
        setStreamNotice(null) // progress — the retry wait is over
      } else if (event === 'reasoning') {
        // Live extended-thinking tokens — grow the in-flight reasoning block until this turn's record lands.
        const delta =
          data !== null && typeof data === 'object' && 'text' in data
            ? (data as { text?: unknown }).text
            : undefined
        if (typeof delta === 'string' && delta.length > 0)
          setStreamingReasoning((prev) => prev + delta)
        setStreamNotice(null)
      } else if (event === 'message') {
        const parsed = agentMessageSchema.safeParse(data)
        if (!parsed.success) return
        setMessages((prev) => mergeMessages(prev, [parsed.data]))
        setStreamNotice(null)
        // 낙관적 버블은 그 내용의 레코드가 도착했을 때만 걷는다 — 팀원 메시지·플랫폼 이벤트도 user 역할로
        // 들어오므로, 아무 user 레코드에나 걷으면 내가 보낸 것이 화면에서 사라진다.
        if (parsed.data.role === 'user') dropPending(parsed.data.content)
        // Each assistant record carries this turn's finalized reasoning + text, so retire the live buffers when it lands.
        if (parsed.data.role === 'assistant') {
          setStreamingReasoning('')
          if (parsed.data.content.trim().length > 0) setStreamingText('')
        }
      } else if (event === 'retry') {
        // 루프가 일시 장애를 대기 중 — 조용한 턴의 이유를 배너로. 최신 시도가 이전 배너를 대체한다.
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
        // 예비 모델로 전환 — 한 줄 안내(다음 진행 이벤트가 지운다).
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
      } else if (event === 'error') {
        // 턴이 실패했다. 보통은 실패 사유가 어시스턴트 레코드로도 남지만(그건 트랜스크립트의 몫), 루프에 닿기
        // 전에 죽은 턴(모델 해석 실패·툴 세션 실패)은 레코드가 없다 — 그때 이 토스트가 유일한 신호다.
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
    [t]
  )

  // 스트림 소유권 토큰: 전송/재접속 리더가 시작될 때마다 증가. 끝난(또는 끊긴) 리더의 뒷정리는 자신이 아직
  // 최신 소유자일 때만 상태를 건드린다 — 낡은 finally 가 새 스트림의 sending 표시를 지우는 사고 방지.
  const streamSeqRef = useRef(0)
  // 스트림이 하나 정리될 때마다 증가 — 재접속 효과의 재실행 트리거(턴 종료 후 204 확인, 네트워크 단절 복구).
  const [attachEpoch, setAttachEpoch] = useState(0)

  // 서버가 이 대화에 대해 실제로 가진 트랜스크립트로 화면을 다시 맞춘다. 스트림은 취소·네트워크 단절로
  // 언제든 끊길 수 있고, 그 순간 서버가 이미 영속했지만 우리에게 닿지 못한 레코드가 남는다 — 다시 맞추지
  // 않으면 그 기록은 화면에서 영구히 사라졌다가 다음에 대화를 열 때 중간에서 되살아난다(리스트 훼손).
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
      // silent — 다음 정착에서 다시 맞춘다
    }
  }, [])

  // 스트림(전송/재접속) 하나가 끝났을 때의 공통 정리. 턴이 만든 엔티티(View/스케줄/팀원)까지 새로고침한다.
  const settleStream = useCallback(
    (seq: number, sessionId: string | null) => {
      if (streamSeqRef.current !== seq) return
      abortRef.current = null
      setStreamingText('')
      setStreamingReasoning('')
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
    [loadSessions, loadTeammates, reconcileMessages, router]
  )

  const send = useCallback(
    async (textArg?: string, refsArg?: AgentReference[]) => {
      const text = (textArg ?? input).trim()
      if (text.length === 0) return
      // 보낸 프롬프트는 컴포저의 ↑ 히스토리로 들어간다(Claude Code 의 전역 history). 전송이 실패해도 남겨
      // 두는 편이 낫다 — 실패한 프롬프트야말로 다시 꺼내 쓰게 된다.
      pushPromptHistory(text)
      // 진행 중인 턴으로의 전송 = REDIRECT (queue-then-interrupt — Claude Code 의 ESC 재해석): 메시지를 러닝
      // 턴의 메일박스에 큐잉하고 현재 스텝만 끊는다 — 루프는 살아서 다음 경계에서 메시지를 흡수하고 방향을
      // 튼다. 칩(레퍼런스/첨부)은 전체 챗 파이프라인이 필요하므로 리다이렉트에 실을 수 없다 — Stop 후 재전송.
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
          // 원자적 리다이렉트: 서버가 라이브니스 확인 후 큐+절단을 한 번에 — 턴 종료와 레이스하면 아무것도
          // 큐하지 않고 404(고아 메일박스 메시지 방지) → 입력 복원 + 재전송 안내.
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
      setPendingUsers((prev) => [...prev, { text, queued: false }])
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
  // 새 대화에서 시작할지는 진입이 정한다(startsFreshConversation): edit 임무는 언제나, analyze/ask 는 진입이
  // `fresh` 를 선언했을 때만 — 스코어카드 둘을 한 대화에서 비교하는 흐름은 기본으로 지키고, 대화의 주제가 그
  // 레코드 하나인 진입(이슈 상세, 빈 분석 캔버스)만 예외를 고른다. 임무 프레이밍은 빈 화면에서만 뜨므로 이
  // 판정이 곧 "진입할 때마다 그 작업에 맞는 패널을 보게 되는가"다.
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
    // 방금 명시적으로 멈춘 턴에는 붙지 않는다: 서버는 루프가 풀린 뒤에야 턴 슬롯을 닫으므로 그 사이의
    // GET /stream 은 아직 200 + 방금 취소한 부분 답변을 replay 한다 — 취소한 내용이 되살아났다 사라지는
    // 깜빡임의 정체다. 한 번만 건너뛴다(대화를 옮기면 switchTo 가 초기화한다).
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
        if (seq !== null) settleStream(seq, id)
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
    suppressAttachRef.current = true
    void fetch(`/api/agent/sessions/${encodeURIComponent(id)}/stop`, { method: 'POST' })
      .then(async (res) => {
        if (!res.ok) return
        // 리다이렉트로 큐에 넣었지만 루프가 끝내 흡수하지 못한 메시지를 서버가 돌려준다 — 입력창에 되돌려
        // 놓는다(Claude Code 의 "Esc 가 큐를 입력으로 되돌린다"). 그러지 않으면 그 문장은 트랜스크립트에도
        // 입력창에도 없이 사라진다. 이미 뭔가 타이핑 중이면 덮지 않는다.
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
