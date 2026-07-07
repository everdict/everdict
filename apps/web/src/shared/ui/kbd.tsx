import type { HTMLAttributes } from 'react'

import { cn } from '@/shared/lib/utils'

// Linear st. key hint — small mono chip (e.g. ⌘ K). Used for sidebar search·command palette hints.
export function Kbd({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border bg-elevated px-1 font-mono text-[10.5px] font-medium leading-none text-muted-foreground',
        className
      )}
      {...props}
    />
  )
}
