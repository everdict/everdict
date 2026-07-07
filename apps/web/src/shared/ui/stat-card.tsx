import type { ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'

// Metric card — Linear st. small label + large tabular-nums number. Dense padding.
export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  tone?: 'default' | 'primary' | 'success' | 'danger'
}) {
  const toneClass = {
    default: 'text-foreground',
    primary: 'text-[var(--color-link)]',
    success: 'text-[var(--color-success)]',
    danger: 'text-destructive',
  }[tone]
  return (
    <div className="group rounded-lg border bg-card p-4 shadow-raise transition-colors hover:border-border-strong">
      <div className="text-[11px] font-[510] uppercase tracking-wide text-faint">{label}</div>
      <div
        className={cn(
          'mt-2 font-mono text-2xl font-[560] leading-none tabular-nums tracking-tight',
          toneClass
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-1.5 text-[12px] text-muted-foreground">{hint}</div>}
    </div>
  )
}
