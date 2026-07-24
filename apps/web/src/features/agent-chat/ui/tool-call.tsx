'use client'

import { useState } from 'react'
import { Check, ChevronRight, Loader2, TriangleAlert, Wrench } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import { JsonView } from '@/shared/ui/json-view'

// A single tool call + (once available) its result, rendered as a compact card in the transcript — the agent's
// "reasoning made visible". Running = spinner; resolved = check (or an alert on error). Args and the result body
// are collapsed by default; JSON results render as a real tree, everything else as monospace text.

function tryParseJson(text: string): unknown | undefined {
  const trimmed = text.trim()
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

export function looksLikeError(result: string): boolean {
  return /^\(?(could not resolve|error|invalid|unknown tool|tool .* failed)/i.test(result.trim())
}

export function ToolCall({ name, args, result }: { name: string; args: string; result?: string }) {
  const t = useTranslations('agentChat')
  const [open, setOpen] = useState(false)
  const running = result === undefined
  const errored = result !== undefined && looksLikeError(result)
  const parsedResult = result !== undefined ? tryParseJson(result) : undefined
  const parsedArgs = tryParseJson(args)
  const hasBody = result !== undefined || (args.trim().length > 0 && args.trim() !== '{}')

  return (
    <div className="animate-in fade-in-0 slide-in-from-bottom-1 rounded-lg border border-border bg-card/60 text-[12px] duration-200">
      <button
        type="button"
        disabled={!hasBody}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center gap-1.5 px-2 py-1.5 text-left',
          hasBody && 'hover:bg-accent/40'
        )}
      >
        {hasBody && (
          <ChevronRight
            className={cn(
              'size-3 shrink-0 text-muted-foreground/60 transition-transform',
              open && 'rotate-90'
            )}
          />
        )}
        <Wrench className="size-3 shrink-0 text-muted-foreground/70" />
        <span className="truncate font-mono text-[11.5px] font-[510] text-foreground/85">
          {name}
        </span>
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

      {open && hasBody && (
        <div className="space-y-1.5 border-t border-border/70 px-2 py-1.5">
          {parsedArgs !== undefined && Object.keys(parsedArgs as object).length > 0 && (
            <div>
              <div className="mb-0.5 text-[10.5px] font-[510] uppercase tracking-wide text-faint">
                {t('toolArgs')}
              </div>
              <JsonView value={parsedArgs} />
            </div>
          )}
          {result !== undefined && (
            <div>
              <div className="mb-0.5 text-[10.5px] font-[510] uppercase tracking-wide text-faint">
                {t('toolResult')}
              </div>
              {parsedResult !== undefined ? (
                <JsonView value={parsedResult} />
              ) : (
                <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-background/70 p-1.5 font-mono text-[11px] text-muted-foreground">
                  {result}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
