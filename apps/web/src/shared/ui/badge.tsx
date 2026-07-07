import type { HTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/shared/lib/utils'

// Linear st. label — small 11px chip, tint background + inset ring, weight 510.
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-[510] leading-none ring-1 ring-inset',
  {
    variants: {
      tone: {
        neutral: 'bg-secondary text-secondary-foreground ring-border',
        success:
          'bg-[var(--color-success)]/12 text-[var(--color-success)] ring-[var(--color-success)]/25',
        danger: 'bg-destructive/12 text-destructive ring-destructive/25',
        warning:
          'bg-[var(--color-warning)]/12 text-[var(--color-warning)] ring-[var(--color-warning)]/25',
        info: 'bg-primary/12 text-[var(--color-accent-foreground)] ring-primary/25',
        outline: 'bg-transparent text-muted-foreground ring-border',
      },
    },
    defaultVariants: { tone: 'neutral' },
  }
)

export function Badge({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}
