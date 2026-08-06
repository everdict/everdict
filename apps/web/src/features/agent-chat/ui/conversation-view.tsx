'use client'

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ChartSpline,
  Check,
  ChevronDown,
  Cpu,
  MessageCircleQuestion,
  MessageSquarePlus,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { useTranslations } from 'next-intl'

import { PinControl } from '@/features/analysis-artifacts'
import {
  AGENT_CHAT_MISSION_INTENTS,
  AGENT_PERMISSION_MODES,
  type AgentAttachmentInput,
  type AgentChatMission,
  type AgentMessage,
  type AgentPermissionMode,
  type AgentReference,
  type AgentSession,
  type AgentTeammate,
} from '@/entities/agent-session'
import { ArtifactCard, type AnalysisArtifact } from '@/entities/analysis-artifact'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { DropdownItem, DropdownLabel, DropdownMenu } from '@/shared/ui/dropdown-menu'
import { Markdown } from '@/shared/ui/markdown'

import { buildTranscript } from '../lib/transcript'
import { Composer } from './composer'
import { ContextBlock } from './context-block'
import { DelegationCard } from './delegation-card'
import { MessageRow, UserBadge, type ChatUser } from './message-row'
import { PermissionPrompt, type PendingPermission } from './permission-prompt'
import { ReasoningBlock } from './reasoning-block'
import { SessionMenu } from './session-menu'
import { SubagentList } from './subagent-list'
import { TeamMenu, type TeammateSpawnInput } from './team-menu'
import { TodoList } from './todo-list'

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

// The conversation's standing permission mode — how the agent's mutating tool calls are approved: ask every time
// (default) · auto (ask only destructive/governance actions) · bypass (never ask) · plan (read-only until the plan
// is approved). Persisted on the session; coarse control-plane RBAC bounds every call regardless.
function PermissionModePicker({
  mode,
  onChange,
}: {
  mode: AgentPermissionMode
  onChange: (mode: AgentPermissionMode) => void
}) {
  const t = useTranslations('agentChat')
  return (
    <DropdownMenu
      align="end"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-label={t('permissionsPick')}
          aria-expanded={open}
          className="flex min-w-0 max-w-[12rem] items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ShieldCheck className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 truncate">{t(`permissionModes.${mode}`)}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      )}
    >
      <DropdownLabel>{t('permissions')}</DropdownLabel>
      {AGENT_PERMISSION_MODES.map((m) => (
        <DropdownItem
          key={m}
          onSelect={() => onChange(m)}
          trailing={mode === m ? <Check className="size-4" /> : undefined}
        >
          {t(`permissionModes.${m}`)}
        </DropdownItem>
      ))}
    </DropdownMenu>
  )
}

// An emitted artifact in the transcript. Memoized like every other item, and it owns its own `action` element:
// building `<PinControl>` at the call site would hand the card a new prop identity on every render and defeat the
// memo — the very thing a chart (SVG marks, a table, a sandboxed frame) can least afford to redraw per keystroke.
const ArtifactRow = memo(function ArtifactRow({ artifact }: { artifact: AnalysisArtifact }) {
  return (
    <div className="px-3 py-1.5">
      <ArtifactCard artifact={artifact} action={<PinControl artifact={artifact} />} />
    </div>
  )
})

// 보냈지만 아직 서버 레코드로 돌아오지 않은 내 메시지. `queued` = 실행 중인 턴에 끼워 넣은 것(리다이렉트)이라
// 진행 중인 답변보다 뒤에 놓인다 — 자기보다 앞선 답변 위에 뜨면 대화 순서가 거짓이 된다.
export interface PendingUserMessage {
  text: string
  queued: boolean
}

const PendingUserRow = memo(function PendingUserRow({
  text,
  user,
}: {
  text: string
  user?: ChatUser
}) {
  return (
    <div className="animate-in fade-in-0 px-3 py-2.5 duration-200">
      <div className="flex gap-2.5">
        <UserBadge user={user} />
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/70">
          {text}
        </p>
      </div>
    </div>
  )
})

export function ConversationView({
  title,
  workspace,
  user,
  models,
  model,
  onChangeModel,
  permissionMode,
  onChangePermissionMode,
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
  artifacts,
  pendingUsers,
  sending,
  streamingText,
  streamingReasoning,
  streamNotice,
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
  onSuggestion,
  pendingPermissions,
  onDecidePermission,
  canvasLink,
  mission,
}: {
  title: string
  // 활성 워크스페이스 — 위임 카드 안의 턴이 자기 run 상세로 링크하는 데 쓴다. 위젯에서 prop 으로
  // 내려온다(위로 import 하지 않는다 — FSD 방향은 아래로만).
  workspace: string
  user?: ChatUser
  models: string[]
  model: string | null
  onChangeModel: (model: string | null) => void
  permissionMode: AgentPermissionMode
  onChangePermissionMode: (mode: AgentPermissionMode) => void
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
  artifacts?: AnalysisArtifact[]
  pendingUsers: PendingUserMessage[]
  sending: boolean
  streamingText: string
  streamingReasoning: string
  // 일시 장애 안내: 재시도 대기(retry — 조용한 턴의 이유) 또는 예비 모델 전환(fallback). null → 없음.
  streamNotice?:
    | { kind: 'retry'; attempt: number; delayMs: number; persistent?: boolean }
    | { kind: 'fallback'; to: string }
    | null
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
  onSuggestion: (text: string) => void
  pendingPermissions: PendingPermission[]
  onDecidePermission: (requestId: string, decision: 'allow' | 'deny') => void
  // An analysis canvas is open in the left half (analyze dashboard / saved View) — the composer shows a
  // "canvas linked" chip so the member knows the agent sees it. null/undefined → no canvas, no chip.
  canvasLink?: { viewName?: string } | null
  // The member arrived from a domain-specific entry ("대화로 편집하기" on a skill, …) rather than the generic
  // chat rail. Same surface, different framing: the empty chat names the task, points at the entity it was
  // opened on (target), and offers suggestions for THAT job instead of the generic workspace prompts.
  mission?: { kind: AgentChatMission; target?: string } | null
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
  }, [messages, sending, pendingUsers, streamingText, atBottom, scrollToBottom])

  useEffect(() => {
    scrollToBottom('auto')
  }, [scrollToBottom])

  // The draft the member is typing lives in this component's props, so EVERY keystroke re-renders this view. The
  // transcript below must not be rebuilt by it: buildTranscript mints fresh todo/sub-agent objects each call, and a
  // new object identity would push a re-render straight through the memoized rows into their markdown parsers.
  const items = useMemo(() => buildTranscript(messages, artifacts), [messages, artifacts])

  // The checklist spinner must track reality, not the persisted snapshot: only the LATEST todos item may animate,
  // and only while a turn is actually running (`sending` covers both a fresh send and a reattached live turn).
  const lastTodosId = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (item?.kind === 'todos') return item.id
    }
    return null
  }, [items])

  const isEmpty = messages.length === 0 && pendingUsers.length === 0 && !sending
  // 임무로 진입했으면 그 임무의 카탈로그 블록(agentChat.missions.<kind>)이 빈 화면의 제목·설명·제안을 대신한다 —
  // 구조는 그대로, 라이팅만 그 작업의 것으로. 임무가 없으면 기존 범용 문구.
  const emptyTitle = mission ? t(`missions.${mission.kind}.title`) : t('emptyMessagesTitle')
  const emptyBody = mission ? t(`missions.${mission.kind}.body`) : t('emptyMessages')
  const suggestions = (
    mission ? t.raw(`missions.${mission.kind}.suggestions`) : t.raw('suggestions')
  ) as string[]

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate pl-1 text-[13px] font-[560] text-foreground">
          {title}
        </span>
        <ModelPicker models={models} model={model} onChange={onChangeModel} />
        <PermissionModePicker mode={permissionMode} onChange={onChangePermissionMode} />
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
                {/* 임무의 성격이 아이콘을 고른다 — 고치는 진입(연필) / 파고드는 진입(차트) / 묻는 진입(말풍선). */}
                {mission === null || mission === undefined ? (
                  <Sparkles className="size-5" strokeWidth={1.75} />
                ) : AGENT_CHAT_MISSION_INTENTS[mission.kind] === 'edit' ? (
                  <Pencil className="size-5" strokeWidth={1.75} />
                ) : AGENT_CHAT_MISSION_INTENTS[mission.kind] === 'analyze' ? (
                  <ChartSpline className="size-5" strokeWidth={1.75} />
                ) : (
                  <MessageCircleQuestion className="size-5" strokeWidth={1.75} />
                )}
              </div>
              <div className="space-y-1">
                <p className="text-[14px] font-[560] text-foreground">{emptyTitle}</p>
                {/* 임무의 대상 — 무엇을 두고 대화하는 중인지 못 박는다(진입한 상세가 떨군 참조 칩의 이름). */}
                {mission?.target !== undefined && (
                  <p className="font-mono text-[12px] text-primary">{mission.target}</p>
                )}
                <p className="text-[12px] leading-relaxed text-muted-foreground">{emptyBody}</p>
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
                if (item.kind === 'context')
                  return (
                    <ContextBlock
                      key={item.id}
                      source={item.source}
                      sender={item.sender}
                      text={item.text}
                    />
                  )
                if (item.kind === 'todos')
                  return (
                    <TodoList
                      key={item.id}
                      todos={item.todos}
                      active={sending && item.id === lastTodosId}
                    />
                  )
                if (item.kind === 'agents')
                  return <SubagentList key={item.id} agents={item.agents} />
                if (item.kind === 'artifact')
                  return <ArtifactRow key={item.id} artifact={item.artifact} />
                if (item.kind === 'delegation')
                  return (
                    <DelegationCard
                      key={item.id}
                      delegation={item.delegation}
                      workspace={workspace}
                    />
                  )
                return <MessageRow key={item.message.id} message={item.message} user={user} />
              })}
              {pendingUsers
                .filter((p) => !p.queued)
                .map((p, i) => (
                  <PendingUserRow key={`pending:${i}:${p.text}`} text={p.text} user={user} />
                ))}
              {streamingReasoning.length > 0 && (
                <ReasoningBlock text={streamingReasoning} streaming />
              )}
              {streamNotice && (
                <div className="animate-in fade-in-0 px-3 py-1.5 duration-200">
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-[11.5px] leading-none text-amber-600 dark:text-amber-400">
                    <RefreshCw className="size-3 animate-spin [animation-duration:2.5s]" />
                    {streamNotice.kind === 'retry'
                      ? t(streamNotice.persistent ? 'retryNoticePersistent' : 'retryNotice', {
                          seconds: Math.max(1, Math.ceil(streamNotice.delayMs / 1000)),
                          attempt: streamNotice.attempt,
                        })
                      : t('fallbackNotice', { model: streamNotice.to })}
                  </span>
                </div>
              )}
              {streamingText.length > 0 ? (
                <div className="animate-in fade-in-0 px-3 py-2.5 duration-200">
                  <Markdown
                    content={streamingText}
                    className="text-[13px] leading-relaxed text-foreground"
                  />
                </div>
              ) : sending && streamingReasoning.length === 0 && !streamNotice ? (
                <div className="animate-in fade-in-0 px-3 py-2.5 duration-200">
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
              ) : null}
              {/* 리다이렉트로 끼워 넣은 메시지는 지금 흐르는 답변 아래에 — 그 답변을 끊으려고 보낸 것이니까. */}
              {pendingUsers
                .filter((p) => p.queued)
                .map((p, i) => (
                  <PendingUserRow key={`queued:${i}:${p.text}`} text={p.text} user={user} />
                ))}
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
        canvasLink={canvasLink}
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
