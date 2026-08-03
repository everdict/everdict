'use client'

import { memo, useState } from 'react'
import { ChevronRight, Inbox, UsersRound } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import { Markdown } from '@/shared/ui/markdown'

// Context the mailbox injected into the conversation — a teammate agent's message or a platform event the running
// turn absorbed. It is input FOR the agent, not something the member said or needs to read, so it renders like
// reasoning: a quiet foldable block, collapsed by default, markdown when expanded (for the curious).
// Memoized like every transcript item — the composer's draft lives above it, and a keystroke must not reach here.
export const ContextBlock = memo(function ContextBlock({
  source,
  sender,
  text,
}: {
  source: 'teammate' | 'event'
  sender?: string
  text: string
}) {
  const t = useTranslations('agentChat')
  const [open, setOpen] = useState(false)
  const Icon = source === 'teammate' ? UsersRound : Inbox
  const label = source === 'teammate' ? t('contextTeammate') : t('contextEvent')

  return (
    <div className="px-3 py-0.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-md py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground/60 transition-transform',
            open && 'rotate-90'
          )}
        />
        <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
        <span className="font-[510]">{label}</span>
        {sender !== undefined && <span className="text-faint">· {sender}</span>}
      </button>
      {open && (
        <div className="mt-1 border-l border-border/70 pl-3">
          <Markdown
            content={text}
            className="text-[12px] leading-relaxed text-muted-foreground [&_*]:text-muted-foreground"
          />
        </div>
      )}
    </div>
  )
})
