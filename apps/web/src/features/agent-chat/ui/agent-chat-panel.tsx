'use client'

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  Bot,
  Check,
  Loader2,
  MessageSquarePlus,
  SendHorizontal,
  Trash2,
  Wrench,
} from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  agentMessageListSchema,
  agentSessionListSchema,
  agentSessionSchema,
  type AgentMessage,
  type AgentSession,
} from '@/entities/agent-session'

// The agent conversation surface embedded in the infra panel's "agent" tab. Two views in one narrow column: the
// session list (the member's chat history) and an open conversation (transcript + composer). Talks only to the
// same-origin BFF (/api/agent/*), which forwards to the agent server. While a turn runs, the transcript is polled
// (the agent server persists each assistant/tool message as it is produced) so tool activity appears live.

function mergeMessages(prev: AgentMessage[], incoming: AgentMessage[]): AgentMessage[] {
  const byId = new Map(prev.map((m) => [m.id, m]))
  for (const m of incoming) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.seq - b.seq)
}

function maxSeq(messages: AgentMessage[]): number {
  return messages.reduce((acc, m) => Math.max(acc, m.seq), -1)
}

// One tool call and (once available) its result — a collapsible activity row. While the result is absent the call
// is still running.
function ToolActivity({ name, args, result }: { name: string; args: string; result?: string }) {
  const running = result === undefined
  return (
    <details className="rounded-lg border border-border bg-muted/40 px-2 py-1 text-[12px]">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-muted-foreground">
        <Wrench className="size-3 shrink-0" />
        <span className="truncate font-mono text-foreground/80" title={args}>
          {name}
        </span>
        {running ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
        ) : (
          <Check className="size-3 shrink-0 text-emerald-500" />
        )}
      </summary>
      {result !== undefined && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-background/70 p-1.5 font-mono text-[11px] text-muted-foreground">
          {result}
        </pre>
      )}
    </details>
  )
}

export function AgentChatPanel() {
  const t = useTranslations('agentChat')
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [pendingUser, setPendingUser] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [messages, sending, pendingUser])

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
      setError(null)
    } catch {
      setError(t('errorGeneric'))
    }
  }, [t])

  const deleteSession = useCallback(
    async (id: string) => {
      if (!window.confirm(t('confirmDelete'))) return
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
        // silent
      }
    },
    [activeId, t]
  )

  const send = useCallback(async () => {
    const text = input.trim()
    if (text.length === 0 || !activeId || sending) return
    setInput('')
    setError(null)
    setSending(true)
    setPendingUser(text)

    const since = { current: maxSeq(messages) }
    let stopped = false
    const pump = async () => {
      try {
        const res = await fetch(
          `/api/agent/sessions/${encodeURIComponent(activeId)}/messages?since=${since.current}`,
          { cache: 'no-store' }
        )
        if (!res.ok) return
        const parsed = agentMessageListSchema.safeParse(await res.json())
        if (!parsed.success || parsed.data.messages.length === 0) return
        setMessages((prev) => mergeMessages(prev, parsed.data.messages))
        since.current = Math.max(since.current, maxSeq(parsed.data.messages))
        if (parsed.data.messages.some((m) => m.role === 'user')) setPendingUser(null)
      } catch {
        // silent — retried on the next tick
      }
    }
    const timer = setInterval(() => {
      if (!stopped) void pump()
    }, 1200)

    try {
      const res = await fetch(`/api/agent/sessions/${encodeURIComponent(activeId)}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      if (!res.ok) throw new Error(await res.text())
      const parsed = agentMessageListSchema.safeParse(await res.json())
      if (parsed.success) setMessages((prev) => mergeMessages(prev, parsed.data.messages))
      await pump()
      setPendingUser(null)
    } catch {
      setPendingUser(null)
      setInput(text)
      setError(t('errorSend'))
    } finally {
      stopped = true
      clearInterval(timer)
      setSending(false)
      void loadSessions()
    }
  }, [input, activeId, sending, messages, loadSessions, t])

  const activeSession = sessions.find((s) => s.id === activeId)

  const resultByCallId = new Map<string, string>()
  for (const m of messages)
    if (m.role === 'tool' && m.toolCallId) resultByCallId.set(m.toolCallId, m.content)

  // --- session list view ---
  if (!activeId) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-[12px] text-muted-foreground">{t('subtitle')}</span>
          <button
            type="button"
            onClick={() => void newConversation()}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[12px] font-[560] text-primary-foreground hover:opacity-90"
          >
            <MessageSquarePlus className="size-3.5" />
            {t('new')}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {sessions.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
              <Bot className="size-7 text-muted-foreground/60" strokeWidth={1.5} />
              <p className="text-[12.5px] text-muted-foreground">{t('empty')}</p>
            </div>
          ) : (
            <ul className="space-y-0.5">
              {sessions.map((s) => (
                <li
                  key={s.id}
                  className="group flex items-center gap-1 rounded-md pr-1 hover:bg-accent"
                >
                  <button
                    type="button"
                    onClick={() => setActiveId(s.id)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                  >
                    <Bot className="size-4 shrink-0 text-muted-foreground/70" strokeWidth={1.75} />
                    <span className="truncate text-[13px] text-foreground">{s.title}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={t('delete')}
                    onClick={() => void deleteSession(s.id)}
                    className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    )
  }

  // --- open conversation view ---
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <button
          type="button"
          aria-label={t('back')}
          onClick={() => setActiveId(null)}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </button>
        <span className="min-w-0 flex-1 truncate text-[13px] font-[560] text-foreground">
          {activeSession?.title ?? ''}
        </span>
        <button
          type="button"
          aria-label={t('delete')}
          onClick={() => activeId && void deleteSession(activeId)}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </button>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {messages.length === 0 && !pendingUser && !sending && (
          <p className="pt-6 text-center text-[12.5px] text-muted-foreground">
            {t('emptyMessages')}
          </p>
        )}
        {messages.map((m) => {
          if (m.role === 'user') {
            return m.content.trim().length > 0 ? (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-primary px-3 py-2 text-[13px] leading-relaxed text-primary-foreground">
                  {m.content}
                </div>
              </div>
            ) : null
          }
          if (m.role === 'assistant') {
            return (
              <Fragment key={m.id}>
                {m.content.trim().length > 0 && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-muted px-3 py-2 text-[13px] leading-relaxed text-foreground">
                      {m.content}
                    </div>
                  </div>
                )}
                {m.toolCalls?.map((tc) => (
                  <ToolActivity
                    key={tc.id}
                    name={tc.name}
                    args={tc.arguments}
                    result={resultByCallId.get(tc.id)}
                  />
                ))}
              </Fragment>
            )
          }
          return null
        })}
        {pendingUser && (
          <div className="flex justify-end">
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-primary px-3 py-2 text-[13px] leading-relaxed text-primary-foreground opacity-70">
              {pendingUser}
            </div>
          </div>
        )}
        {sending && (
          <div className="flex justify-start">
            <div className="inline-flex items-center gap-2 rounded-2xl bg-muted px-3 py-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t('thinking')}
            </div>
          </div>
        )}
      </div>

      {error && <p className="px-3 pb-1 text-[12px] text-destructive">{error}</p>}

      <div className="border-t border-border p-2">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            rows={2}
            placeholder={t('placeholder')}
            className="max-h-40 min-h-[38px] flex-1 resize-none rounded-lg border border-border bg-background px-2.5 py-2 text-[13px] outline-none placeholder:text-muted-foreground/70 focus:border-primary/50"
          />
          <button
            type="button"
            aria-label={t('send')}
            disabled={sending || input.trim().length === 0}
            onClick={() => void send()}
            className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <SendHorizontal className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )
}
