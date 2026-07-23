'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import {
  agentMessageListSchema,
  agentMessageSchema,
  agentSessionListSchema,
  agentSessionSchema,
  type AgentAttachmentInput,
  type AgentMessage,
  type AgentReference,
  type AgentSession,
} from '@/entities/agent-session'

import { ConversationView } from './conversation-view'
import { SessionList } from './session-list'

// The agent conversation surface for the infra panel's "agent" tab. Owns all state + I/O; delegates rendering to
// SessionList (history) and ConversationView (the open chat). Talks only to the same-origin BFF (/api/agent/*).
// A turn streams over SSE: `delta` events grow the live assistant bubble, `message` events merge each persisted
// record (so tool cards + the finalized answer appear live); the Stop button aborts the request → the server
// aborts the loop.

function mergeMessages(prev: AgentMessage[], incoming: AgentMessage[]): AgentMessage[] {
  const byId = new Map(prev.map((m) => [m.id, m]))
  for (const m of incoming) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

export function AgentChatPanel() {
  const t = useTranslations('agentChat')
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [pendingUser, setPendingUser] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [references, setReferences] = useState<AgentReference[]>([])
  const [attachments, setAttachments] = useState<AgentAttachmentInput[]>([])
  const [streamingText, setStreamingText] = useState('')
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

  useEffect(() => {
    if (!activeId) {
      setMessages([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/agent/sessions/${encodeURIComponent(activeId)}/messages`, {
          cache: 'no-store',
        })
        if (!res.ok) return
        const parsed = agentMessageListSchema.safeParse(await res.json())
        if (!cancelled && parsed.success) setMessages(parsed.data.messages)
      } catch {
        // silent
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeId])

  const newConversation = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) return
      const parsed = agentSessionSchema.safeParse(await res.json())
      if (!parsed.success) return
      setSessions((prev) => [parsed.data, ...prev])
      setActiveId(parsed.data.id)
      setMessages([])
    } catch {
      toast.error(t('errorGeneric'))
    }
  }, [t])

  const deleteSession = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/agent/sessions/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        })
        if (!res.ok) return
        setSessions((prev) => prev.filter((s) => s.id !== id))
        if (activeId === id) {
          setActiveId(null)
          setMessages([])
        }
      } catch {
        toast.error(t('errorGeneric'))
      }
    },
    [activeId, t]
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

  const send = useCallback(
    async (textArg?: string, refsArg?: AgentReference[]) => {
      const text = (textArg ?? input).trim()
      if (text.length === 0 || !activeId || sending) return
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

      const controller = new AbortController()
      abortRef.current = controller

      // Apply one SSE event: a text delta grows the live assistant bubble; a persisted record merges into the
      // transcript (and, for the finalized assistant text, retires the live bubble).
      const handleEvent = (event: string, data: unknown) => {
        if (event === 'delta') {
          const delta =
            data !== null && typeof data === 'object' && 'text' in data
              ? (data as { text?: unknown }).text
              : undefined
          if (typeof delta === 'string' && delta.length > 0)
            setStreamingText((prev) => prev + delta)
        } else if (event === 'message') {
          const parsed = agentMessageSchema.safeParse(data)
          if (!parsed.success) return
          setMessages((prev) => mergeMessages(prev, [parsed.data]))
          if (parsed.data.role === 'user') setPendingUser(null)
          if (parsed.data.role === 'assistant' && parsed.data.content.trim().length > 0)
            setStreamingText('')
        }
      }

      try {
        const res = await fetch(`/api/agent/sessions/${encodeURIComponent(activeId)}/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({
            message: text,
            ...(refs.length > 0 ? { references: refs } : {}),
            ...(atts.length > 0 ? { attachments: atts } : {}),
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
        setPendingUser(null)
        setSending(false)
        void loadSessions()
      }
    },
    [input, activeId, sending, references, attachments, loadSessions, t]
  )

  const stop = useCallback(() => abortRef.current?.abort(), [])

  const regenerate = useCallback(() => {
    const lastUser = [...messages]
      .reverse()
      .find((m) => m.role === 'user' && m.content.trim().length > 0)
    if (lastUser) void send(lastUser.content, lastUser.references)
  }, [messages, send])

  if (!activeId) {
    return (
      <SessionList
        sessions={sessions}
        activeId={null}
        onOpen={setActiveId}
        onNew={() => void newConversation()}
        onDelete={(id) => void deleteSession(id)}
        onRename={(id, title) => void renameSession(id, title)}
      />
    )
  }

  const active = sessions.find((s) => s.id === activeId)
  return (
    <ConversationView
      title={active?.title ?? ''}
      messages={messages}
      pendingUser={pendingUser}
      sending={sending}
      streamingText={streamingText}
      input={input}
      references={references}
      attachments={attachments}
      onChange={setInput}
      onSend={() => void send()}
      onStop={stop}
      onPickReference={(r) =>
        setReferences((prev) =>
          prev.some((x) => x.type === r.type && x.id === r.id) ? prev : [...prev, r]
        )
      }
      onRemoveReference={(i) => setReferences((prev) => prev.filter((_, j) => j !== i))}
      onPickAttachment={(a) => setAttachments((prev) => [...prev, a])}
      onRemoveAttachment={(i) => setAttachments((prev) => prev.filter((_, j) => j !== i))}
      onBack={() => setActiveId(null)}
      onRegenerate={regenerate}
      onSuggestion={(txt) => void send(txt)}
    />
  )
}
