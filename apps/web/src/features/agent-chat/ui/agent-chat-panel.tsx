'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Bot, Loader2, MessageSquarePlus, SendHorizontal } from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  agentMessageListSchema,
  agentSessionListSchema,
  agentSessionSchema,
  type AgentMessage,
  type AgentSession,
} from '@/entities/agent-session'
import { cn } from '@/shared/lib/utils'

// The agent conversation surface embedded in the infra panel's "agent" tab. Two views in one narrow column: the
// session list (the member's chat history) and an open conversation (streamed-in transcript + composer). Talks
// only to the same-origin BFF (/api/agent/*), which forwards to the agent server. MVP transport = request/response
// per turn (the chat POST runs the whole loop); a live token stream is a later enhancement.

// Only user turns and assistant turns that carry text are shown; tool-call plumbing (empty assistant turns, tool
// results) is persisted for the model's context but stays out of the readable transcript.
function isVisible(m: AgentMessage): boolean {
  if (m.role === 'user') return true
  return m.role === 'assistant' && m.content.trim().length > 0
}

export function AgentChatPanel() {
  const t = useTranslations('agentChat')
  const [sessions, setSessions] = useState<AgentSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
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
  }, [messages, sending])

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

  const send = useCallback(async () => {
    const text = input.trim()
    if (text.length === 0 || !activeId || sending) return
    setInput('')
    setSending(true)
    setError(null)
    const optimistic: AgentMessage = {
      id: `tmp-${sessions.length}-${messages.length}`,
      tenant: '',
      sessionId: activeId,
      seq: (messages.at(-1)?.seq ?? -1) + 1,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, optimistic])
    try {
      const res = await fetch(`/api/agent/sessions/${encodeURIComponent(activeId)}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      if (!res.ok) throw new Error(await res.text())
      const parsed = agentMessageListSchema.safeParse(await res.json())
      if (parsed.success) {
        setMessages((prev) => [
          ...prev.filter((m) => m.id !== optimistic.id),
          ...parsed.data.messages,
        ])
      }
      void loadSessions()
    } catch {
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id))
      setInput(text)
      setError(t('errorSend'))
    } finally {
      setSending(false)
    }
  }, [input, activeId, sending, messages, sessions.length, loadSessions, t])

  const activeSession = sessions.find((s) => s.id === activeId)
  const visible = messages.filter(isVisible)

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
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setActiveId(s.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                  >
                    <Bot className="size-4 shrink-0 text-muted-foreground/70" strokeWidth={1.75} />
                    <span className="truncate text-[13px] text-foreground">{s.title}</span>
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
        <span className="truncate text-[13px] font-[560] text-foreground">
          {activeSession?.title ?? ''}
        </span>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {visible.length === 0 && !sending && (
          <p className="pt-6 text-center text-[12.5px] text-muted-foreground">
            {t('emptyMessages')}
          </p>
        )}
        {visible.map((m) => (
          <div
            key={m.id}
            className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}
          >
            <div
              className={cn(
                'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-[13px] leading-relaxed',
                m.role === 'user'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-foreground'
              )}
            >
              {m.content}
            </div>
          </div>
        ))}
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
