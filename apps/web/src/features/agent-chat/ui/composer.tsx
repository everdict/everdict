'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AtSign, BarChart3, Paperclip, SendHorizontal, Square, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { AgentAttachmentInput, AgentReference } from '@/entities/agent-session'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Kbd } from '@/shared/ui/kbd'

import {
  EMPTY_PROMPT_HISTORY_CURSOR,
  isCaretOnFirstLine,
  isCaretOnLastLine,
  promptHistoryDown,
  promptHistoryUp,
  pushPromptHistory,
  readPromptHistory,
  type PromptHistoryCursor,
  type PromptHistoryStep,
} from '../lib/prompt-history'
import { MentionPicker, ReferenceChip } from './mention-picker'

// Esc 를 두 번 눌러 입력을 비우는 창(Claude Code 의 DOUBLE_PRESS_TIMEOUT_MS 와 같은 값).
const ESC_CLEAR_WINDOW_MS = 800

const TEXT_EXT =
  /\.(txt|md|log|json|ya?ml|xml|toml|csv|tsv|ini|env|conf|js|jsx|ts|tsx|py|sh|go|rs|java|rb|sql|html?|css|diff|patch)$/i
const MAX_READ_BYTES = 512 * 1024

function isTextLike(file: File): boolean {
  return (
    file.type.startsWith('text/') || file.type === 'application/json' || TEXT_EXT.test(file.name)
  )
}

// Read a dropped/picked file into an attachment: text files carry their content (folded into the model context);
// binary/oversized files carry metadata only (a named chip).
async function readAttachment(file: File): Promise<AgentAttachmentInput> {
  const meta: AgentAttachmentInput = {
    name: file.name,
    size: file.size,
    ...(file.type ? { mimeType: file.type } : {}),
  }
  if (isTextLike(file) && file.size <= MAX_READ_BYTES) {
    try {
      return { ...meta, content: await file.text() }
    } catch {
      return meta
    }
  }
  return meta
}

function AttachmentChip({
  attachment,
  onRemove,
  removeLabel,
}: {
  attachment: AgentAttachmentInput
  onRemove: () => void
  removeLabel: string
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-muted/50 px-1.5 py-0.5 text-[11px]">
      <Paperclip className="size-3 shrink-0 text-muted-foreground/70" />
      <span className="truncate font-mono text-foreground/80">{attachment.name}</span>
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        className="shrink-0 text-muted-foreground hover:text-destructive"
      >
        <X className="size-3" />
      </button>
    </span>
  )
}

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  sending,
  references,
  attachments,
  onPickReference,
  onRemoveReference,
  onPickAttachment,
  onRemoveAttachment,
  canvasLink,
}: {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  onStop: () => void
  sending: boolean
  references: AgentReference[]
  attachments: AgentAttachmentInput[]
  onPickReference: (r: AgentReference) => void
  onRemoveReference: (index: number) => void
  onPickAttachment: (a: AgentAttachmentInput) => void
  onRemoveAttachment: (index: number) => void
  canvasLink?: { viewName?: string } | null
}) {
  const t = useTranslations('agentChat')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  // Esc 한 번은 "지울까요?"까지만 간다 — 창 안에 두 번째가 오면 그때 비운다(긴 초안이 오타 한 번으로 날아가면 안 된다).
  const [escArmed, setEscArmed] = useState(false)
  const escTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 프롬프트 히스토리는 첫 ↑ 에서만 읽는다(저장소 접근을 타이핑 경로에서 뺀다). 커서는 렌더와 무관한 탐색 상태라 ref.
  const historyRef = useRef<string[] | null>(null)
  const cursorRef = useRef<PromptHistoryCursor>(EMPTY_PROMPT_HISTORY_CURSOR)
  // 히스토리가 값을 갈아끼운 뒤 놓을 커서 위치 — value 가 DOM 에 반영된 다음에야 적용할 수 있다.
  const caretRef = useRef<number | null>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 176)}px`
    const caret = caretRef.current
    if (caret !== null) {
      caretRef.current = null
      el.setSelectionRange(caret, caret)
    }
  }, [value])

  useEffect(() => () => clearTimeout(escTimerRef.current ?? undefined), [])

  const disarmEsc = useCallback(() => {
    clearTimeout(escTimerRef.current ?? undefined)
    escTimerRef.current = null
    setEscArmed(false)
  }, [])

  const resetHistory = useCallback(() => {
    cursorRef.current = EMPTY_PROMPT_HISTORY_CURSOR
    historyRef.current = null
  }, [])

  const applyHistoryStep = useCallback(
    (step: PromptHistoryStep) => {
      cursorRef.current = step.cursor
      caretRef.current = step.caret === 'start' ? 0 : step.value.length
      onChange(step.value)
    },
    [onChange]
  )

  const handleFiles = useCallback(
    async (files: File[]) => {
      for (const file of files) onPickAttachment(await readAttachment(file))
    },
    [onPickAttachment]
  )

  const canSend = value.trim().length > 0
  const hasChips = references.length > 0 || attachments.length > 0

  return (
    <div
      className={cn(
        'border-t border-border bg-background/60 p-2 backdrop-blur-sm transition-colors',
        dragActive && 'bg-primary/5'
      )}
      onDragOver={(e) => {
        e.preventDefault()
        setDragActive(true)
      }}
      onDragLeave={(e) => {
        e.preventDefault()
        setDragActive(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragActive(false)
        if (e.dataTransfer.files.length > 0) void handleFiles(Array.from(e.dataTransfer.files))
      }}
    >
      {/* Ambient status, not a removable chip: an analysis canvas is open and every turn carries its live
          state — the member sees that the agent sees it. */}
      {canvasLink && (
        <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[10.5px] text-muted-foreground">
          <BarChart3 className="size-3 shrink-0 text-primary" />
          <span className="truncate">
            {canvasLink.viewName
              ? t('canvasLinkedNamed', { name: canvasLink.viewName })
              : t('canvasLinked')}
          </span>
        </div>
      )}
      {hasChips && (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {references.map((r, i) => (
            <ReferenceChip
              key={`${r.type}:${r.id}:${i}`}
              reference={r}
              onRemove={() => onRemoveReference(i)}
            />
          ))}
          {attachments.map((a, i) => (
            <AttachmentChip
              key={`${a.name}:${i}`}
              attachment={a}
              removeLabel={t('attachRemove')}
              onRemove={() => onRemoveAttachment(i)}
            />
          ))}
        </div>
      )}

      <div className="relative">
        {mentionOpen && (
          <MentionPicker
            onClose={() => setMentionOpen(false)}
            onPick={(ref) => {
              onPickReference(ref)
              setMentionOpen(false)
            }}
          />
        )}
        <div
          className={cn(
            'flex items-end gap-0.5 rounded-xl border border-border bg-background px-1.5 py-1 transition-colors focus-within:border-primary/50',
            dragActive && 'border-primary/60'
          )}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void handleFiles(Array.from(e.target.files))
              e.target.value = ''
            }}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('attach')}
            onClick={() => fileInputRef.current?.click()}
            className="mb-0.5 shrink-0"
          >
            <Paperclip />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('mentionAdd')}
            aria-pressed={mentionOpen}
            onClick={() => setMentionOpen((o) => !o)}
            className={cn('mb-0.5 shrink-0', mentionOpen && 'bg-accent text-foreground')}
          >
            <AtSign />
          </Button>
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              const v = e.target.value
              disarmEsc()
              // Typing '@' opens the mention picker; the char is dropped (the picker has its own search input).
              if (v.endsWith('@') && !value.endsWith('@')) {
                onChange(v.slice(0, -1))
                setMentionOpen(true)
                return
              }
              onChange(v)
            }}
            onKeyDown={(e) => {
              // 조합 중인 키는 입력기(한글·일본어·중국어)의 것이다 — 조합을 확정하는 Enter 를 전송으로 삼키면
              // "안녕하세"가 날아간다. e.key === 'Process' 는 isComposing 을 안 주는 브라우저의 같은 신호.
              if (e.nativeEvent.isComposing || e.key === 'Process') return

              // Esc 사다리(Claude Code 의 chat:cancel → 더블 Esc 로 비우기): ① 진행 중인 턴을 끊고 ② 없으면
              // 입력을 비우고 ③ 비어 있으면 그냥 흘려보낸다 — 창 밖의 리스너가 패널을 닫는 것이 마지막 단이다.
              // 소비한 단에서만 전파를 멈춘다(멘션 피커는 capture 단계에서 이보다 먼저 Esc 를 가져간다).
              if (e.key === 'Escape') {
                if (sending) {
                  e.preventDefault()
                  e.stopPropagation()
                  disarmEsc()
                  onStop()
                  return
                }
                if (value.length > 0) {
                  e.preventDefault()
                  e.stopPropagation()
                  if (escArmed) {
                    disarmEsc()
                    // 지우기 전에 히스토리에 넣는다 — ↑ 한 번이면 되돌릴 수 있다(Claude Code 와 같은 안전망).
                    pushPromptHistory(value)
                    resetHistory()
                    onChange('')
                  } else {
                    clearTimeout(escTimerRef.current ?? undefined)
                    setEscArmed(true)
                    escTimerRef.current = setTimeout(() => setEscArmed(false), ESC_CLEAR_WINDOW_MS)
                  }
                }
                return
              }

              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                disarmEsc()
                // sending 중의 Enter 도 onSend 로 — 패널이 REDIRECT(queue-then-interrupt)로 처리한다.
                if (canSend) {
                  resetHistory()
                  onSend()
                }
                return
              }

              // ↑/↓ = 프롬프트 히스토리. 여러 줄 입력에서는 커서가 먼저 줄을 오르내리고, 첫 줄/마지막 줄에
              // 닿았을 때만 히스토리 차례다.
              if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey) {
                const caret = e.currentTarget.selectionStart
                if (e.key === 'ArrowUp') {
                  if (!isCaretOnFirstLine(value, caret)) return
                  historyRef.current ??= readPromptHistory()
                  const step = promptHistoryUp(cursorRef.current, historyRef.current, value)
                  // 더 올라갈 데가 없으면 초안을 그대로 둔다 — 아무 일도 일어나지 않는 것이 옳다.
                  if (!step) return
                  e.preventDefault()
                  applyHistoryStep(step)
                  return
                }
                if (!isCaretOnLastLine(value, caret)) return
                const step = promptHistoryDown(cursorRef.current, historyRef.current ?? [])
                if (!step) return
                e.preventDefault()
                applyHistoryStep(step)
              }
            }}
            rows={1}
            placeholder={t('placeholder')}
            className="max-h-44 min-h-[30px] flex-1 resize-none self-center bg-transparent py-1 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/60"
          />
          {sending ? (
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label={t('stop')}
              onClick={onStop}
              className="mb-0.5 shrink-0"
            >
              <Square className="fill-current" />
            </Button>
          ) : (
            <Button
              size="icon-sm"
              aria-label={t('send')}
              disabled={!canSend}
              onClick={onSend}
              className="mb-0.5 shrink-0"
            >
              <SendHorizontal />
            </Button>
          )}
        </div>
      </div>

      {/* 힌트 줄은 지금 Esc 가 무엇을 할지 말해 준다 — 오버로드된 키는 안내가 없으면 그냥 사고다. */}
      <div className="mt-1 flex items-center gap-1.5 px-1 text-[10.5px] text-faint">
        {escArmed ? (
          <>
            <Kbd>esc</Kbd>
            <span className="text-foreground/70">{t('escAgainToClear')}</span>
          </>
        ) : sending ? (
          <>
            <Kbd>esc</Kbd>
            <span>{t('stop')}</span>
          </>
        ) : (
          <>
            <Kbd>↵</Kbd>
            <span>{t('send')}</span>
            <span className="text-border">·</span>
            <Kbd>⇧↵</Kbd>
            <span>{t('newline')}</span>
            <span className="text-border">·</span>
            <Kbd>↑</Kbd>
            <span>{t('historyPrev')}</span>
          </>
        )}
      </div>
    </div>
  )
}
