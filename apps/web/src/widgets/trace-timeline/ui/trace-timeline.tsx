import { useTranslations } from 'next-intl'

import { summarizeTraceEvent, traceKindColor, type TraceEvent } from '@/entities/run'
import { cn } from '@/shared/lib/utils'

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
              traceKindColor(e.kind)
            )}
          />
          <div className="flex items-center gap-2">
            <code className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] font-[510]">
              {e.kind}
            </code>
            <span className="font-mono text-[11px] text-faint">t={e.t}</span>
          </div>
          <p className="mt-1 break-all text-[12px] leading-relaxed text-muted-foreground">
            {summarizeTraceEvent(e)}
          </p>
        </li>
      ))}
    </ol>
  )
}
