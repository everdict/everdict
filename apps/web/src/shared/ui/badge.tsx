import type { HTMLAttributes } from 'react'

import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/shared/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        neutral: 'bg-secondary text-secondary-foreground',
        success: 'bg-[var(--color-success)]/15 text-[var(--color-success)]',
        danger: 'bg-destructive/15 text-destructive',
        info: 'bg-accent text-accent-foreground',
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
