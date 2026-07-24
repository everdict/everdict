'use client'

import { useState } from 'react'
import { Brain, ChevronRight } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import { Markdown } from '@/shared/ui/markdown'

// The model's reasoning / extended-thinking for one turn, as a quiet foldable block (Claude/o1-style "thought
// process") — collapsed by default so it never competes with the answer, but one click away for the curious. While
// the turn is live it stays open and pulses so the reader can watch the thinking stream in.
export function ReasoningBlock({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const t = useTranslations('agentChat')
  const [open, setOpen] = useState(streaming)

  return (
    <div className="py-0.5 pl-[2.875rem] pr-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-md py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn('size-3 shrink-0 text-muted-foreground/60 transition-transform', open && 'rotate-90')}
        />
        <Brain className={cn('size-3.5 shrink-0', streaming && 'animate-pulse text-primary')} strokeWidth={1.75} />
        <span className="font-[510]">{streaming ? t('reasoningLive') : t('reasoning')}</span>
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
}
