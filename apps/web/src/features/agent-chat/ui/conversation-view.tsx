'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, Check, ChevronDown, Cpu, MessageSquarePlus, Sparkles, User } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type {
  AgentAttachmentInput,
  AgentMessage,
  AgentReference,
  AgentSession,
  AgentTeammate,
} from '@/entities/agent-session'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { DropdownItem, DropdownLabel, DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Markdown } from '@/shared/ui/markdown'

import { buildTranscript } from '../lib/transcript'
import { AgentAvatar } from './agent-avatar'
import { Composer } from './composer'
import { MessageRow } from './message-row'
import { PermissionPrompt, type PendingPermission } from './permission-prompt'
import { ReasoningBlock } from './reasoning-block'
import { SessionMenu } from './session-menu'
import { TeamMenu, type TeammateSpawnInput } from './team-menu'
import { TodoList } from './todo-list'
import { ToolGroup } from './tool-group'

// A compact model selector in the conversation header — the member picks which registered workspace model powers
// this conversation. "Workspace default" (null) falls back to the workspace AgentSpec's model / the server default.
// No registered models → nothing to pick, so it renders nothing (the agent uses the default).
function ModelPicker({
  models,
  model,
  onChange,
}: {
  models: string[]
  model: string | null
  onChange: (model: string | null) => void
}) {
  const t = useTranslations('agentChat')
  if (models.length === 0) return null
  return (
    <DropdownMenu
      align="end"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-label={t('modelPick')}
          aria-expanded={open}
          className="flex min-w-0 max-w-[10rem] items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Cpu className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 truncate">{model ?? t('modelDefault')}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      )}
    >
      <DropdownLabel>{t('model')}</DropdownLabel>
      <DropdownItem
        onSelect={() => onChange(null)}
        trailing={model === null ? <Check className="size-4" /> : undefined}
      >
        {t('modelDefault')}
      </DropdownItem>
      {models.map((m) => (
        <DropdownItem
          key={m}
          onSelect={() => onChange(m)}
          trailing={model === m ? <Check className="size-4" /> : undefined}
        >
          {m}
        </DropdownItem>
      ))}
    </DropdownMenu>
  )
}

export function ConversationView({
  title,
  models,
  model,
  onChangeModel,
  sessions,
  activeId,
  onOpenSession,
  onNewConversation,
  onDeleteSession,
  onRenameSession,
  teammates,
  onSpawnTeammate,
  onStopTeammate,
  messages,
  pendingUser,
  sending,
  streamingText,
  streamingReasoning,
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
  onRegenerate,
  onSuggestion,
  pendingPermissions,
  onDecidePermission,
}: {
  title: string
  models: string[]
  model: string | null
  onChangeModel: (model: string | null) => void
  sessions: AgentSession[]
  activeId: string | null
  onOpenSession: (id: string) => void
  onNewConversation: () => void
  onDeleteSession: (id: string) => void
  onRenameSession: (id: string, title: string) => void
  teammates: AgentTeammate[]
  onSpawnTeammate: (input: TeammateSpawnInput) => void
  onStopTeammate: (id: string) => void
  messages: AgentMessage[]
  pendingUser: string | null
  sending: boolean
  streamingText: string
  streamingReasoning: string
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
  onRegenerate: () => void
  onSuggestion: (text: string) => void
  pendingPermissions: PendingPermission[]
  onDecidePermission: (requestId: string, decision: 'allow' | 'deny') => void
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

  const items = buildTranscript(messages)

  let lastAssistantId: string | null = null
  for (const m of messages)
    if (m.role === 'assistant' && m.content.trim().length > 0) lastAssistantId = m.id

  const isEmpty = messages.length === 0 && !pendingUser && !sending
  const suggestions = t.raw('suggestions') as string[]

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <AgentAvatar size="sm" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-[560] text-foreground">
          {title}
        </span>
        <ModelPicker models={models} model={model} onChange={onChangeModel} />
        <TeamMenu teammates={teammates} onSpawn={onSpawnTeammate} onStop={onStopTeammate} />
        <SessionMenu
          sessions={sessions}
          activeId={activeId}
          onOpen={onOpenSession}
          onDelete={onDeleteSession}
          onRename={onRenameSession}
        />
        <Button variant="ghost" size="icon-sm" aria-label={t('new')} onClick={onNewConversation}>
          <MessageSquarePlus />
        </Button>
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
              {items.map((item) => {
                if (item.kind === 'reasoning')
                  return <ReasoningBlock key={item.id} text={item.text} />
                if (item.kind === 'todos') return <TodoList key={item.id} todos={item.todos} />
                if (item.kind === 'tools') return <ToolGroup key={item.id} calls={item.calls} />
                return (
                  <MessageRow
                    key={item.message.id}
                    message={item.message}
                    isLastAssistant={item.message.id === lastAssistantId}
                    onRegenerate={onRegenerate}
                  />
                )
              })}
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
              {streamingReasoning.length > 0 && (
                <ReasoningBlock text={streamingReasoning} streaming />
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
              ) : sending && streamingReasoning.length === 0 ? (
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

      <PermissionPrompt pending={pendingPermissions} onDecide={onDecidePermission} />

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
