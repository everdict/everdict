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
    <div className="rounded-2xl border bg-card p-5 shadow-sm transition-shadow hover:shadow-md">
      <div className={cn('font-mono text-3xl font-semibold tabular-nums', toneClass)}>{value}</div>
      <div className="mt-1 text-sm font-medium text-muted-foreground">{label}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground/70">{hint}</div>}
    </div>
  )
}
