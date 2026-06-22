import type { ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'

// Toss풍 지표 카드: 큰 숫자 + 라벨 + 선택적 보조 텍스트/톤.
export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string
  value: ReactNode
  hint?: string
  tone?: 'default' | 'primary' | 'success' | 'danger'
}) {
  const toneClass = {
    default: 'text-foreground',
    primary: 'text-primary',
    success: 'text-[var(--color-success)]',
    danger: 'text-destructive',
  }[tone]
  return (
    <div className="group rounded-xl border bg-card p-5 transition-colors hover:border-[var(--color-muted-foreground)]/30">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          'mt-2 font-mono text-[28px] font-semibold leading-none tabular-nums',
          toneClass
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-1.5 text-xs text-muted-foreground/70">{hint}</div>}
    </div>
  )
}
