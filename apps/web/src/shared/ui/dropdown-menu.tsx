'use client'

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'

// 의존성 없는 경량 드롭다운 메뉴(Linear st. popover). 외부클릭/Esc 로 닫힘, 트리거 기준 정렬.
const Ctx = createContext<{ close: () => void } | null>(null)

export function DropdownMenu({
  trigger,
  children,
  align = 'start',
  side = 'bottom',
  className,
  contentClassName,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode
  children: ReactNode
  align?: 'start' | 'end'
  side?: 'bottom' | 'top'
  className?: string
  contentClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className={cn('relative', className)}>
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <Ctx.Provider value={{ close: () => setOpen(false) }}>
          <div
            role="menu"
            className={cn(
              'absolute z-50 min-w-[200px] overflow-hidden rounded-lg border border-border bg-popover p-1 text-[13px] shadow-pop',
              'origin-top animate-in fade-in-0 zoom-in-95 duration-100',
              side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
              align === 'end' ? 'right-0' : 'left-0',
              contentClassName
            )}
          >
            {children}
          </div>
        </Ctx.Provider>
      )}
    </div>
  )
}

export function DropdownItem({
  children,
  onSelect,
  icon,
  tone = 'default',
  className,
}: {
  children: ReactNode
  onSelect?: () => void
  icon?: ReactNode
  tone?: 'default' | 'danger'
  className?: string
}) {
  const ctx = useContext(Ctx)
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        onSelect?.()
        ctx?.close()
      }}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground',
        tone === 'danger'
          ? 'text-destructive hover:bg-destructive/10 [&_svg]:text-destructive'
          : 'text-foreground hover:bg-accent',
        className
      )}
    >
      {icon}
      <span className="flex-1 truncate">{children}</span>
    </button>
  )
}

export function DropdownLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 py-1.5 text-[11px] font-[510] uppercase tracking-wide text-faint">
      {children}
    </p>
  )
}

export function DropdownSeparator() {
  return <div className="my-1 h-px bg-border" />
}
