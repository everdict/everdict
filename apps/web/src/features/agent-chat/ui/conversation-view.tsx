'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, Sparkles, User } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { AgentAttachmentInput, AgentMessage, AgentReference } from '@/entities/agent-session'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Markdown } from '@/shared/ui/markdown'

import { AgentAvatar } from './agent-avatar'
import { Composer } from './composer'
import { MessageRow } from './message-row'

export function ConversationView({
  title,
  messages,
  pendingUser,
  sending,
  streamingText,
  input,
  references,
  attachments,
  onChange,
  onSend,
  onStop,
  onPickReference,
  onRemoveReference,
  onPickAttachment,
  onRemoveAttachment,
  onBack,
  onRegenerate,
  onSuggestion,
}: {
  title: string
  messages: AgentMessage[]
  pendingUser: string | null
  sending: boolean
  streamingText: string
  input: string
  references: AgentReference[]
  attachments: AgentAttachmentInput[]
  onChange: (v: string) => void
  onSend: () => void
  onStop: () => void
  onPickReference: (r: AgentReference) => void
  onRemoveReference: (index: number) => void
  onPickAttachment: (a: AgentAttachmentInput) => void
  onRemoveAttachment: (index: number) => void
  onBack: () => void
  onRegenerate: () => void
  onSuggestion: (text: string) => void
}) {
  const t = useTranslations('agentChat')
  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 48)
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior })
  }, [])

  // Only follow new content when the reader is already at the bottom — never yank them back while they scroll up.
  useLayoutEffect(() => {
    if (atBottom) scrollToBottom('auto')
  }, [messages, sending, pendingUser, streamingText, atBottom, scrollToBottom])

  useEffect(() => {
    scrollToBottom('auto')
  }, [scrollToBottom])

  const resultByCallId = new Map<string, string>()
  for (const m of messages)
    if (m.role === 'tool' && m.toolCallId) resultByCallId.set(m.toolCallId, m.content)

  let lastAssistantId: string | null = null
  for (const m of messages)
    if (m.role === 'assistant' && m.content.trim().length > 0) lastAssistantId = m.id

  const isEmpty = messages.length === 0 && !pendingUser && !sending
  const suggestions = t.raw('suggestions') as string[]

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <Button variant="ghost" size="icon-sm" aria-label={t('back')} onClick={onBack}>
          <ArrowLeft />
        </Button>
        <AgentAvatar size="sm" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-[560] text-foreground">
          {title}
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto py-2">
          {isEmpty ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 px-5 text-center">
              <div className="grid size-11 place-items-center rounded-2xl bg-primary/12 text-primary">
                <Sparkles className="size-5" strokeWidth={1.75} />
              </div>
              <div className="space-y-1">
                <p className="text-[14px] font-[560] text-foreground">{t('emptyMessagesTitle')}</p>
                <p className="text-[12px] leading-relaxed text-muted-foreground">
                  {t('emptyMessages')}
                </p>
              </div>
              <div className="flex w-full max-w-xs flex-col gap-1.5">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => onSuggestion(s)}
                    className="rounded-lg border border-border bg-card/50 px-3 py-2 text-left text-[12.5px] text-foreground/90 transition-colors hover:border-primary/40 hover:bg-accent"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {messages.map((m) => (
                <MessageRow
                  key={m.id}
                  message={m}
                  resultByCallId={resultByCallId}
                  isLastAssistant={m.id === lastAssistantId}
                  onRegenerate={onRegenerate}
                />
              ))}
              {pendingUser && (
                <div className="animate-in fade-in-0 px-3 py-2.5 duration-200">
                  <div className="flex gap-2.5">
                    <div className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
                      <User className="size-3.5" />
                    </div>
                    <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/70">
                      {pendingUser}
                    </p>
                  </div>
                </div>
              )}
              {streamingText.length > 0 ? (
                <div className="animate-in fade-in-0 px-3 py-2.5 duration-200">
                  <div className="flex gap-2.5">
                    <AgentAvatar />
                    <Markdown
                      content={streamingText}
                      className="min-w-0 flex-1 text-[13px] leading-relaxed text-foreground"
                    />
                  </div>
                </div>
              ) : sending ? (
                <div className="animate-in fade-in-0 px-3 py-2.5 duration-200">
                  <div className="flex items-center gap-2.5">
                    <AgentAvatar />
                    <span className="flex gap-1" aria-label={t('thinking')}>
                      {[0, 1, 2].map((i) => (
                        <span
                          key={i}
                          className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50"
                          style={{ animationDelay: `${i * 140}ms` }}
                        />
                      ))}
                    </span>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </div>

        {!atBottom && (
          <button
            type="button"
            aria-label={t('scrollToBottom')}
            onClick={() => scrollToBottom('smooth')}
            className={cn(
              'absolute bottom-2 left-1/2 grid size-8 -translate-x-1/2 place-items-center rounded-full',
              'border border-border bg-popover text-muted-foreground shadow-pop',
              'animate-in fade-in-0 zoom-in-95 hover:text-foreground'
            )}
          >
            <ArrowDown className="size-4" />
          </button>
        )}
      </div>

      <Composer
        value={input}
        onChange={onChange}
        onSend={onSend}
        onStop={onStop}
        sending={sending}
        references={references}
        attachments={attachments}
        onPickReference={onPickReference}
        onRemoveReference={onRemoveReference}
        onPickAttachment={onPickAttachment}
        onRemoveAttachment={onRemoveAttachment}
      />
    </div>
  )
}
