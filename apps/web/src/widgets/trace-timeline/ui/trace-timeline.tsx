import { useTranslations } from 'next-intl'

import type { TraceEvent } from '@/entities/run'
import { cn } from '@/shared/lib/utils'

const KIND_COLOR: Record<string, string> = {
  message: 'bg-muted-foreground',
  llm_call: 'bg-primary',
  tool_call: 'bg-[var(--color-success)]',
  tool_result: 'bg-[var(--color-success)]',
  env_action: 'bg-accent-foreground',
  error: 'bg-destructive',
}

function summarize(e: TraceEvent): string {
  const a = e as Record<string, unknown>
  switch (e.kind) {
    case 'message':
      return `${String(a.role ?? '')}: ${String(a.text ?? '').slice(0, 140)}`
    case 'llm_call': {
      const cost = a.cost as { usd?: number } | undefined
      return `model ${String(a.model ?? '')}${cost?.usd != null ? ` · $${cost.usd}` : ''}`
    }
    case 'tool_call':
      return `${String(a.name ?? '')}(${JSON.stringify(a.args ?? {}).slice(0, 80)})`
    case 'tool_result':
      return `→ ${a.ok ? 'ok' : 'fail'} ${String(a.output ?? '').slice(0, 80)}`
    case 'error':
      return String(a.message ?? '')
    default:
      return ''
  }
}

export function TraceTimeline({ trace }: { trace: TraceEvent[] }) {
  const t = useTranslations('traceTimeline')
  if (trace.length === 0) {
    return <p className="text-[13px] text-muted-foreground">{t('empty')}</p>
  }
  return (
    <ol className="relative space-y-3.5 border-l border-border/70 pl-6">
      {trace.map((e, i) => (
        <li key={i} className="relative">
          <span
            className={cn(
              'absolute -left-[1.625rem] top-1 size-2.5 rounded-full ring-4 ring-card',
              KIND_COLOR[e.kind] ?? 'bg-muted-foreground'
            )}
          />
          <div className="flex items-center gap-2">
            <code className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] font-[510]">
              {e.kind}
            </code>
            <span className="font-mono text-[11px] text-faint">t={e.t}</span>
          </div>
          <p className="mt-1 break-all text-[12px] leading-relaxed text-muted-foreground">
            {summarize(e)}
          </p>
        </li>
      ))}
    </ol>
  )
}
