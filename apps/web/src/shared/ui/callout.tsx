import type { ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/shared/lib/utils'

// Error/notice box — Linear st. 8px round, tint background + body color inherited, hint separated as muted.
const calloutVariants = cva('rounded-lg border px-3.5 py-3 text-[13px] leading-relaxed', {
  variants: {
    tone: {
      danger: 'border-destructive/30 bg-destructive/8 text-destructive',
      warning:
        'border-[var(--color-warning)]/30 bg-[var(--color-warning)]/8 text-[var(--color-warning)]',
      info: 'border-primary/25 bg-primary/6 text-foreground',
      muted: 'border-border bg-muted/50 text-muted-foreground',
    },
  },
  defaultVariants: { tone: 'info' },
})

export function Callout({
  tone,
  children,
  hint,
  className,
}: VariantProps<typeof calloutVariants> & {
  children: ReactNode
  hint?: ReactNode
  className?: string
}) {
  return (
    <div className={cn(calloutVariants({ tone }), className)}>
      <div>{children}</div>
      {hint ? <div className="mt-1 text-[12px] text-muted-foreground">{hint}</div> : null}
    </div>
  )
}
