'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import type { AgentChatMission, AgentReference } from '@/entities/agent-session'
import type { KnowledgeGraph } from '@/entities/knowledge'
import { membersSchema } from '@/entities/member'
import { queueSnapshotSchema, type QueueSnapshot } from '@/entities/queue'

// Infra split-view state — the screen splits into an eval side (left: routed pages) and an infra side (right:
// the floating panel). The panel hosts the REAL routed infra pages (schedules / runtimes / runs) in same-origin
// iframes with their own history — full existing screens, fully independent navigation — plus the purpose-built
// work tab (queue snapshot). The vertical rail (divider) and the panel share this context; it is mounted once
// in the [workspace] shell, so left-side navigation never interrupts anything playing on the right.

export type WorkAuthor = { name: string; avatarUrl?: string }

export type InfraTab = 'schedules' | 'runtimes' | 'runs' | 'work' | 'agent' | 'files' | 'knowledge'

// A deep-open request into a page tab's iframe — e.g. openRun() points the runs tab at that run's REAL detail
// page. seq forces re-application even for a repeated identical target (the user may have navigated away inside
// the iframe in between).
export type FrameRequest = { tab: InfraTab; path: string; seq: number }

// A request to prefill the agent chat composer and reveal the chat: an entity reference chip (ref) and/or a draft
// prompt text (prompt) — e.g. "edit this skill" opens the chat with the skill referenced AND the ask pre-typed
// (the member reviews and sends; nothing auto-sends). Buffered here because the AgentChatPanel mounts the 'agent'
// tab lazily — the panel consumes this on mount, then clears it via consumePendingMention so a later tab re-mount
// does not re-inject the same prefill.
// `mission` marks a DOMAIN-SPECIFIC entry (Settings › Skills 상세의 "대화로 편집하기" 같은 전용 버튼): 패널 구조는
// 그대로지만 빈 화면의 라이팅·제안이 그 작업에 맞춰 갈린다. 범용 "대화에서 분석" 진입은 mission 없이 기본 문구를 쓴다.
export type PendingMention = {
  ref?: AgentReference
  prompt?: string
  mission?: AgentChatMission
}

// postMessage `type` a detail page rendered INSIDE the infra panel's iframe (run / runtime) sends to the PARENT
// shell — which owns the agent chat — to mention its entity. Same-origin only.
export const MENTION_IN_CHAT_MESSAGE = 'everdict:mention-in-chat'

// postMessage `type` a comment thread's agent answer sends to open its backing discussion session in the chat
// (features/discuss posts it — to the parent when framed, to its own window otherwise — since a feature cannot
// import this widget; keep the literal in features/discuss/ui/comment-thread.tsx in sync). Same-origin only.
export const OPEN_AGENT_SESSION_MESSAGE = 'everdict:open-agent-session'

// A request to open the agent chat on a SPECIFIC existing session (a comment thread's workspace-visible
// discussion session) in watch mode. Buffered like PendingMention — the panel consumes it on mount.
export type PendingSession = { id: string }

type InfraPanelValue = {
  workspace: string
  open: boolean
  tab: InfraTab
  // Rail button semantics — same tab while open = collapse; otherwise open on that tab.
  toggleTab: (tab: InfraTab) => void
  // Non-toggling open (command palette, deep entries) — always ends open on the given tab.
  openTab: (tab: InfraTab) => void
  close: () => void
  // Deep entries — open the panel on a tab AND point its iframe at the real page for the entity.
  openRun: (id: string) => void
  openRuntime: (kind: 'runtime' | 'runner', id: string) => void
  openSchedule: (id: string) => void
  frameRequest: FrameRequest | null
  // Open the agent chat and drop an entity reference into the composer (from an entity detail page). `mission`
  // frames the chat for a domain-specific task (e.g. editing a skill) instead of the generic analysis copy.
  mentionInChat: (ref: AgentReference, mission?: AgentChatMission) => void
  // Open the agent chat with a draft prompt pre-typed (and optionally an entity referenced) — nothing auto-sends.
  askAgent: (prompt: string, ref?: AgentReference) => void
  pendingMention: PendingMention | null
  consumePendingMention: () => void
  // Open the agent chat on a specific existing session (a comment thread's discussion session) in watch mode.
  openAgentSession: (sessionId: string) => void
  pendingSession: PendingSession | null
  consumePendingSession: () => void
  // The files tab — a workspace-filesystem file rendered interactively in the panel (Settings › Files selects
  // it; the tab has no rail button). openFile re-points an open viewer; closeFile clears it (after a delete).
  filePath: string | null
  openFile: (path: string) => void
  closeFile: () => void
  // Bumped after every panel-side filesystem mutation (save / move / delete) so a host tree refetches in place.
  fsRevision: number
  notifyFsMutation: () => void
  // The knowledge tab — Settings › Knowledge publishes the map it draws, then picks nodes in it; the panel renders
  // the picked node's identity and the relationships around it from that same data, so the map and the detail can
  // never disagree. Picking a neighbour in the panel writes back here, which re-centres the map. Purpose-built like
  // the files tab (no iframe, no rail button).
  knowledgeGraph: KnowledgeGraph | null
  publishKnowledgeGraph: (graph: KnowledgeGraph) => void
  knowledgeNodeId: string | null
  openKnowledgeNode: (nodeId: string | null) => void
  snapshot: QueueSnapshot | null
  authors: Record<string, WorkAuthor>
}

const InfraPanelContext = createContext<InfraPanelValue | null>(null)

const POLL_OPEN_MS = 4_000 // when open — live progress
const POLL_CLOSED_MS = 20_000 // when closed — only refresh the rail badge counts

export function InfraPanelProvider({
  workspace,
  children,
}: {
  workspace: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<InfraTab>('work')
  const [frameRequest, setFrameRequest] = useState<FrameRequest | null>(null)
  const frameSeq = useRef(0)
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null)
  const [authors, setAuthors] = useState<Record<string, WorkAuthor>>({})
  const authorsLoaded = useRef(false)
  const [pendingMention, setPendingMention] = useState<PendingMention | null>(null)

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/queue', { cache: 'no-store' })
      if (!res.ok) return
      const parsed = queueSnapshotSchema.safeParse(await res.json())
      if (parsed.success) setSnapshot(parsed.data)
    } catch {
      // Poll failures stay silent — retried on the next cycle.
    }
  }, [])

  // Poll — once immediately on mount and whenever open changes, then periodically (fast open / slow closed). Skip while the tab is hidden.
  useEffect(() => {
    void poll()
    const timer = setInterval(
      () => {
        if (typeof document !== 'undefined' && document.hidden) return
        void poll()
      },
      open ? POLL_OPEN_MS : POLL_CLOSED_MS
    )
    const onFocus = () => void poll()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [poll, open])

  // Authors (name/avatar) — lazy-loaded only on the panel's first open (so we don't add a member lookup to every page).
  useEffect(() => {
    if (!open || authorsLoaded.current) return
    authorsLoaded.current = true
    void (async () => {
      try {
        const res = await fetch('/api/members', { cache: 'no-store' })
        if (!res.ok) return
        const parsed = membersSchema.safeParse(await res.json())
        if (!parsed.success) return
        const map: Record<string, WorkAuthor> = {}
        for (const m of parsed.data)
          map[m.subject] = {
            name: m.name ?? m.email?.split('@')[0] ?? m.subject,
            ...(m.avatarUrl ? { avatarUrl: m.avatarUrl } : {}),
          }
        setAuthors(map)
      } catch {
        // Ignore an author-enrichment failure — fall back to showing the subject.
      }
    })()
  }, [open])

  // Close with Esc.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const toggleTab = useCallback(
    (next: InfraTab) => {
      if (open && tab === next) setOpen(false)
      else {
        setTab(next)
        setOpen(true)
      }
    },
    [open, tab]
  )

  const openTab = useCallback((next: InfraTab) => {
    setTab(next)
    setOpen(true)
  }, [])

  const close = useCallback(() => setOpen(false), [])

  const request = useCallback((target: InfraTab, path: string) => {
    frameSeq.current += 1
    setFrameRequest({ tab: target, path, seq: frameSeq.current })
    setTab(target)
    setOpen(true)
  }, [])

  const openRun = useCallback(
    (id: string) => request('runs', `/runs/${encodeURIComponent(id)}`),
    [request]
  )

  const openRuntime = useCallback(
    (kind: 'runtime' | 'runner', id: string) =>
      request(
        'runtimes',
        kind === 'runner'
          ? `/runtimes/self/${encodeURIComponent(id)}`
          : `/runtimes/${encodeURIComponent(id)}`
      ),
    [request]
  )

  // The schedules surface is the list page (no per-schedule route) — open it; the id stays for a future anchor.
  const openSchedule = useCallback((_id: string) => request('schedules', '/schedules'), [request])

  // Reveal the agent chat with this entity pre-mentioned. Buffer the reference (the panel consumes it on mount)
  // and open on the 'agent' tab. A mission (전용 진입) rides along so the panel can frame the task.
  const mentionInChat = useCallback((ref: AgentReference, mission?: AgentChatMission) => {
    setPendingMention({ ref, ...(mission ? { mission } : {}) })
    setTab('agent')
    setOpen(true)
  }, [])

  // Reveal the agent chat with a draft prompt pre-typed (and optionally an entity referenced) — the "ask the
  // agent to do X with this" entry (e.g. edit a skill from its detail page). The member still presses send.
  const askAgent = useCallback((prompt: string, ref?: AgentReference) => {
    setPendingMention({ prompt, ...(ref ? { ref } : {}) })
    setTab('agent')
    setOpen(true)
  }, [])

  const consumePendingMention = useCallback(() => setPendingMention(null), [])

  // Reveal a specific agent conversation (a comment thread's "view details") — the panel opens it in watch mode.
  const [pendingSession, setPendingSession] = useState<PendingSession | null>(null)
  const openAgentSession = useCallback((sessionId: string) => {
    setPendingSession({ id: sessionId })
    setTab('agent')
    setOpen(true)
  }, [])
  const consumePendingSession = useCallback(() => setPendingSession(null), [])

  // The files tab — Settings › Files selects a path, the panel renders it. State lives here so the viewer
  // survives left-side navigation and the tree (a separate surface) can mirror the selection.
  const [filePath, setFilePath] = useState<string | null>(null)
  const [fsRevision, setFsRevision] = useState(0)
  const openFile = useCallback((path: string) => {
    setFilePath(path)
    setTab('files')
    setOpen(true)
  }, [])
  const closeFile = useCallback(() => setFilePath(null), [])
  const notifyFsMutation = useCallback(() => setFsRevision((revision) => revision + 1), [])

  // The knowledge tab. The published map outlives the graph screen (navigating the left half never empties the
  // panel); clearing the SELECTION keeps the tab open on its empty state, which is what tapping empty canvas means.
  const [knowledgeGraph, setKnowledgeGraph] = useState<KnowledgeGraph | null>(null)
  const [knowledgeNodeId, setKnowledgeNodeId] = useState<string | null>(null)
  const publishKnowledgeGraph = useCallback((graph: KnowledgeGraph) => setKnowledgeGraph(graph), [])
  const openKnowledgeNode = useCallback((nodeId: string | null) => {
    setKnowledgeNodeId(nodeId)
    if (nodeId === null) return
    setTab('knowledge')
    setOpen(true)
  }, [])

  return (
    <InfraPanelContext.Provider
      value={{
        workspace,
        open,
        tab,
        toggleTab,
        openTab,
        close,
        openRun,
        openRuntime,
        openSchedule,
        frameRequest,
        mentionInChat,
        askAgent,
        pendingMention,
        consumePendingMention,
        openAgentSession,
        pendingSession,
        consumePendingSession,
        filePath,
        openFile,
        closeFile,
        fsRevision,
        notifyFsMutation,
        knowledgeGraph,
        publishKnowledgeGraph,
        knowledgeNodeId,
        openKnowledgeNode,
        snapshot,
        authors,
      }}
    >
      {children}
    </InfraPanelContext.Provider>
  )
}

export function useInfraPanel(): InfraPanelValue {
  const ctx = useContext(InfraPanelContext)
  if (!ctx) throw new Error('useInfraPanel must be used within InfraPanelProvider')
  return ctx
}

// Non-throwing variant — for a component (e.g. the "analyze in chat" button) that may render INSIDE the panel's
// iframe, where the embed shell mounts no InfraPanelProvider. Returns null there (the button posts to the parent
// shell instead).
export function useInfraPanelOptional(): InfraPanelValue | null {
  return useContext(InfraPanelContext)
}

// The "analyze in chat" dispatch: drop a reference into the agent chat composer + reveal the chat. On an eval/settings
// page (left shell) it calls the panel context directly; on a page rendered INSIDE the panel's iframe there is no
// provider, so it posts up to the parent shell over the same-origin bridge. Shared by MentionInChatButton and the
// observability trace browser (which mentions a trace by (source, id)).
export function useMentionInChat(): (
  reference: AgentReference,
  mission?: AgentChatMission
) => void {
  const infra = useInfraPanelOptional()
  return useCallback(
    (reference: AgentReference, mission?: AgentChatMission) => {
      const framed = typeof window !== 'undefined' && window.self !== window.top
      if (framed) {
        window.parent.postMessage(
          { type: MENTION_IN_CHAT_MESSAGE, reference, mission },
          window.location.origin
        )
        return
      }
      infra?.mentionInChat(reference, mission)
    },
    [infra]
  )
}
