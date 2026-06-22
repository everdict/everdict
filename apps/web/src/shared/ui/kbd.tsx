import type { HTMLAttributes } from 'react'

import { cn } from '@/shared/lib/utils'

// Linear st. 키 힌트 — 작은 모노 chip(예: ⌘ K). 사이드바 검색·command 팔레트 힌트에 사용.
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
