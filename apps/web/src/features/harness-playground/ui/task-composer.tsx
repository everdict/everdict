'use client'

import { MessageSquarePlus, SendHorizontal } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Kbd } from '@/shared/ui/kbd'
import { Tooltip } from '@/shared/ui/tooltip'

// The playground's input: one prompt = one test case (or, on a conversation session, one more TURN of the same
// conversation). Enter sends, Shift+Enter breaks the line (the chat grammar members already know). Disabled
// while a task runs — the control plane refuses a concurrent submit with 409, so the composer waits rather than
// inviting a race. `freshAvailable` (process conversations only) arms a "new conversation" toggle: the NEXT
// message starts a fresh thread in the same environment — a service conversation's thread IS its session, so
// the toggle never shows there.
export function TaskComposer({
  value,
  onChange,
  onSend,
  disabled,
  conversation = false,
  freshAvailable = false,
  freshPending = false,
  onToggleFresh,
}: {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  disabled: boolean
  conversation?: boolean
  freshAvailable?: boolean
  freshPending?: boolean
  onToggleFresh?: () => void
}) {
  const t = useTranslations('playground')
  const canSend = !disabled && value.trim().length > 0

  return (
    <div className="border-t border-border px-2 py-2">
      <div className="flex items-end gap-1 rounded-lg border border-border bg-card px-2 py-1 focus-within:border-primary/50">
        {freshAvailable && onToggleFresh !== undefined && (
          <Tooltip content={t('freshConversation')}>
            <button
              type="button"
              aria-label={t('freshConversation')}
              aria-pressed={freshPending}
              onClick={onToggleFresh}
              disabled={disabled}
              className={cn(
                'mb-1 grid size-6 shrink-0 place-items-center rounded-md',
                freshPending
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground/70 hover:text-foreground',
                'disabled:opacity-50'
              )}
            >
              <MessageSquarePlus className="size-3.5" />
            </button>
          </Tooltip>
        )}
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (canSend) onSend()
            }
          }}
          disabled={disabled}
          rows={1}
          placeholder={t(conversation ? 'turnPlaceholder' : 'taskPlaceholder')}
          className="max-h-44 min-h-[30px] flex-1 resize-none self-center bg-transparent py-1 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/60 disabled:opacity-60"
        />
        <Button
          size="icon-sm"
          aria-label={t('send')}
          disabled={!canSend}
          onClick={onSend}
          className="mb-0.5 shrink-0"
        >
          <SendHorizontal />
        </Button>
      </div>
      <div className="mt-1 flex items-center gap-1.5 px-1 text-[10.5px] text-faint">
        <Kbd>↵</Kbd>
        <span>{t('send')}</span>
        <span className="text-border">·</span>
        <Kbd>⇧↵</Kbd>
        <span>{t('newline')}</span>
        {freshPending && (
          <>
            <span className="text-border">·</span>
            <span className="text-primary">{t('freshPending')}</span>
          </>
        )}
      </div>
    </div>
  )
}
