'use client'

import { SendHorizontal } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Button } from '@/shared/ui/button'
import { Kbd } from '@/shared/ui/kbd'

// The playground's input: one prompt = one test case. Enter sends, Shift+Enter breaks the line (the chat
// grammar members already know). Disabled while a task runs — the control plane refuses a concurrent submit
// with 409, so the composer waits rather than inviting a race.
export function TaskComposer({
  value,
  onChange,
  onSend,
  disabled,
}: {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  disabled: boolean
}) {
  const t = useTranslations('playground')
  const canSend = !disabled && value.trim().length > 0

  return (
    <div className="border-t border-border px-2 py-2">
      <div className="flex items-end gap-1 rounded-lg border border-border bg-card px-2 py-1 focus-within:border-primary/50">
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
          placeholder={t('taskPlaceholder')}
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
      </div>
    </div>
  )
}
