'use client'

import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/shared/lib/utils'

// Lightweight modal — backdrop blur + close on Esc + body scroll-lock. Shared base for the command palette/confirm dialogs.
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

  // If not open (closed) or SSR (no document), don't render.
  if (!open || typeof document === 'undefined') return null

  // Portal into document.body — avoids the issue where the app shell's transform/filter (grain·glow) ancestor becomes
  // the containing block for fixed and the backdrop can't cover the whole viewport (so fixed inset-0 is always viewport-relative).
  return createPortal(
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
    </div>,
    document.body
  )
}
