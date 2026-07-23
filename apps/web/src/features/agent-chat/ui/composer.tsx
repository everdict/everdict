'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { AtSign, Paperclip, SendHorizontal, Square, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { AgentAttachmentInput, AgentReference } from '@/entities/agent-session'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Kbd } from '@/shared/ui/kbd'

import { MentionPicker, ReferenceChip } from './mention-picker'

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
}) {
  const t = useTranslations('agentChat')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [dragActive, setDragActive] = useState(false)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 176)}px`
  }, [value])

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
              // Typing '@' opens the mention picker; the char is dropped (the picker has its own search input).
              if (v.endsWith('@') && !value.endsWith('@')) {
                onChange(v.slice(0, -1))
                setMentionOpen(true)
                return
              }
              onChange(v)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                if (canSend && !sending) onSend()
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

      <div className="mt-1 flex items-center gap-1.5 px-1 text-[10.5px] text-faint">
        <Kbd>↵</Kbd>
        <span>{t('send')}</span>
        <span className="text-border">·</span>
        <Kbd>⇧↵</Kbd>
        <span>{t('newline')}</span>
      </div>
    </div>
  )
}
