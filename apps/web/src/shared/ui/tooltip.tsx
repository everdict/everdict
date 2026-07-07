'use client'

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Info } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { createPortal } from 'react-dom'

import { cn } from '@/shared/lib/utils'

// Custom tooltip (Linear st. popover) — don't render guide/notice text inline on screen;
// show it only on hover/focus of the trigger (usually the info icon). Dependency-free lightweight implementation, like Combobox.
// The content is a body portal + fixed placement — it's not clipped inside an overflow-hidden container (settings list card, etc.) or a stacking
// context (compute coordinates from the trigger rect on open, close on scroll/resize).
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
  const [style, setStyle] = useState<CSSProperties>() // undefined = closed
  const triggerRef = useRef<HTMLSpanElement>(null)

  function openAtTrigger() {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const transforms: string[] = []
    if (side === 'top') transforms.push('translateY(-100%)')
    if (align === 'center') transforms.push('translateX(-50%)')
    if (align === 'end') transforms.push('translateX(-100%)')
    setStyle({
      position: 'fixed',
      top: side === 'top' ? rect.top - 6 : rect.bottom + 6,
      left:
        align === 'center' ? rect.left + rect.width / 2 : align === 'end' ? rect.right : rect.left,
      ...(transforms.length > 0 ? { transform: transforms.join(' ') } : {}),
    })
  }
  const close = () => setStyle(undefined)

  // While open, scroll/resize → coordinates go stale, so close (for a hover tooltip, closing is more natural than recalculating).
  useEffect(() => {
    if (!style) return
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [style])

  return (
    <span
      ref={triggerRef}
      className={cn('relative inline-flex', className)}
      onMouseEnter={openAtTrigger}
      onMouseLeave={close}
      onFocus={openAtTrigger}
      onBlur={close}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close()
      }}
    >
      {children}
      {style &&
        createPortal(
          <span
            role="tooltip"
            style={style}
            className={cn(
              'pointer-events-none z-50 w-max max-w-[300px] rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11.5px] leading-relaxed text-foreground shadow-pop',
              'animate-in fade-in-0 zoom-in-95 duration-100',
              contentClassName
            )}
          >
            {content}
          </span>,
          document.body
        )}
    </span>
  )
}

// info-icon trigger tooltip — the standard way to surface guide text (no inline captions).
export function InfoTip({
  content,
  side,
  align,
  className,
  'aria-label': ariaLabel,
}: {
  content: ReactNode
  side?: 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  className?: string
  'aria-label'?: string
}) {
  const t = useTranslations('ui')
  return (
    <Tooltip
      content={content}
      {...(side ? { side } : {})}
      {...(align ? { align } : {})}
      {...(className ? { className } : {})}
    >
      <button
        type="button"
        aria-label={ariaLabel ?? t('infoTipAria')}
        className="grid size-4.5 place-items-center rounded text-faint transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
      >
        <Info className="size-3.5" />
      </button>
    </Tooltip>
  )
}
