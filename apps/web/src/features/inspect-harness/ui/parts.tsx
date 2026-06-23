import type { ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'

// inspect-harness 뷰 공통 프리미티브 — 라벨/값 필드, 모노 칩, 라벨 섹션.

export function Field({
  label,
  value,
  mono = true,
  className,
}: {
  label: ReactNode
  value: ReactNode
  mono?: boolean
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-[10.5px] font-[510] uppercase tracking-wide text-faint">{label}</dt>
      <dd
        className={cn(
          'mt-1 truncate text-[13px] text-foreground',
          mono && 'font-mono text-[12.5px]'
        )}
      >
        {value}
      </dd>
    </div>
  )
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code
      className={cn(
        'rounded bg-secondary px-1.5 py-0.5 font-mono text-[12px] text-muted-foreground ring-1 ring-inset ring-border',
        className
      )}
    >
      {children}
    </code>
  )
}

export function SubSection({
  title,
  icon,
  count,
  children,
}: {
  title: ReactNode
  icon?: ReactNode
  count?: number
  children: ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        {icon && <span className="text-muted-foreground">{icon}</span>}
        <h3 className="text-[13px] font-[560] tracking-[-0.01em] text-foreground">{title}</h3>
        {count !== undefined && (
          <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10.5px] font-[510] tabular-nums text-muted-foreground ring-1 ring-inset ring-border">
            {count}
          </span>
        )}
      </div>
      {children}
    </section>
  )
}
