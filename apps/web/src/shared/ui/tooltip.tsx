'use client'

import { useState, type ReactNode } from 'react'
import { Info } from 'lucide-react'

import { cn } from '@/shared/lib/utils'

// 커스텀 툴팁(Linear st. popover) — 가이드/안내 문구는 화면에 인라인 노출하지 않고,
// 트리거(주로 info 아이콘)에 호버/포커스했을 때만 보여준다. Combobox 처럼 의존성 없는 경량 구현.
export function Tooltip({
  content,
  children,
  side = 'top',
  align = 'center',
  className,
  contentClassName,
}: {
  content: ReactNode
  children: ReactNode
  side?: 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  className?: string
  contentClassName?: string
}) {
  const [open, setOpen] = useState(false)

  const position = cn(
    side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
    align === 'center' && 'left-1/2 -translate-x-1/2',
    align === 'start' && 'left-0',
    align === 'end' && 'right-0'
  )

  return (
    <span
      className={cn('relative inline-flex', className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false)
      }}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className={cn(
            'pointer-events-none absolute z-50 w-max max-w-[300px] rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11.5px] leading-relaxed text-foreground shadow-pop',
            'animate-in fade-in-0 zoom-in-95 duration-100',
            position,
            contentClassName
          )}
        >
          {content}
        </span>
      )}
    </span>
  )
}

// info 아이콘 트리거 툴팁 — 안내 문구의 표준 노출 방식(인라인 캡션 금지).
export function InfoTip({
  content,
  side,
  align,
  className,
  'aria-label': ariaLabel = '도움말',
}: {
  content: ReactNode
  side?: 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  className?: string
  'aria-label'?: string
}) {
  return (
    <Tooltip
      content={content}
      {...(side ? { side } : {})}
      {...(align ? { align } : {})}
      {...(className ? { className } : {})}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        className="grid size-4.5 place-items-center rounded text-faint transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
      >
        <Info className="size-3.5" />
      </button>
    </Tooltip>
  )
}
