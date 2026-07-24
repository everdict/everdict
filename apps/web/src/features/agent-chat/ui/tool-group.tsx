'use client'

import { useState } from 'react'
import { Check, ChevronRight, Loader2, TriangleAlert, Wrench } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import type { ToolCallView } from '../lib/transcript'
import { ToolCall, looksLikeError } from './tool-call'

// A run of consecutive tool calls, collapsed into ONE compact line ("Used 4 tools" · running/done/error glyph) that
// expands to the individual tool cards. The user rarely cares that the agent searched three registries to answer —
// but it stays one click away. A lone tool call skips the wrapper and renders as its own (already foldable) card, so
// the grouping only kicks in when it actually reduces clutter.
export function ToolGroup({ calls }: { calls: ToolCallView[] }) {
  const t = useTranslations('agentChat')
  const [open, setOpen] = useState(false)

  if (calls.length === 0) return null
  if (calls.length === 1) {
    const only = calls[0]
    if (!only) return null
    return (
      <div className="py-0.5 pl-[2.875rem] pr-3">
        <ToolCall name={only.name} args={only.args} result={only.result} />
      </div>
    )
  }

  const running = calls.some((c) => c.result === undefined)
  const errored = calls.some((c) => c.result !== undefined && looksLikeError(c.result))
  const names = [...new Set(calls.map((c) => c.name))]
  const preview = names.slice(0, 3).join(', ') + (names.length > 3 ? '…' : '')

  return (
    <div className="py-0.5 pl-[2.875rem] pr-3">
      <div className="rounded-lg border border-border bg-card/60 text-[12px]">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-accent/40"
        >
          <ChevronRight
            className={cn('size-3 shrink-0 text-muted-foreground/60 transition-transform', open && 'rotate-90')}
          />
          <Wrench className="size-3 shrink-0 text-muted-foreground/70" />
          <span className="shrink-0 font-[510] text-foreground/85">
            {t('toolsUsed', { count: calls.length })}
          </span>
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground/70">{preview}</span>
          <span className="ml-auto shrink-0">
            {running ? (
              <Loader2 className="size-3.5 animate-spin text-primary" />
            ) : errored ? (
              <TriangleAlert className="size-3.5 text-amber-500" />
            ) : (
              <Check className="size-3.5 text-emerald-500" />
            )}
          </span>
        </button>
        {open && (
          <div className="space-y-1 border-t border-border/70 p-1.5">
            {calls.map((c) => (
              <ToolCall key={c.id} name={c.name} args={c.args} result={c.result} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
