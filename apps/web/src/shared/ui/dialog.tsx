'use client'

import { useEffect, type ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'

// 경량 모달 — backdrop blur + Esc 닫힘 + body 스크롤락. command 팔레트/확인 다이얼로그 공용 베이스.
export function Dialog({
  open,
  onClose,
  children,
  className,
  align = 'center',
  labelledBy,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  className?: string
  align?: 'center' | 'top'
  labelledBy?: string
}) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className={cn(
        'fixed inset-0 z-[100] flex justify-center bg-black/45 backdrop-blur-[2px] animate-in fade-in-0 duration-150',
        align === 'center' ? 'items-center p-4' : 'items-start px-4 pt-[12vh]'
      )}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={cn(
          'w-full overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-pop',
          'animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 duration-150',
          className
        )}
      >
        {children}
      </div>
    </div>
  )
}
