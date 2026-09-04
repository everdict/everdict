'use client'

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/shared/lib/utils'

// Dependency-free lightweight dropdown menu (Linear st. popover). Closes on outside-click/Esc, aligned to the trigger.
const Ctx = createContext<{ close: () => void } | null>(null)

// The gap (px) between the trigger and the popover. The old mt-1.5/mb-1.5 moved into the fixed coordinate calculation.
const GAP = 6

// The box a popover aligns to — the four viewport edges of `getBoundingClientRect()`, and nothing more, so
// the geometry below is testable without a DOM.
type Box = { top: number; right: number; bottom: number; left: number }
type Measurable = { getBoundingClientRect: () => Box }

// Align to the TRIGGER, not to the wrapper `div` that holds it. The wrapper is a block box, so it stretches
// to whatever cell it sits in (a property row's value column, a table cell) — measuring that box parks an
// `align="end"` menu at the CELL's right edge, far from the small button that opened it.
export function triggerBoxOf(wrapper: Measurable & { firstElementChild: Measurable | null }): Box {
  return (wrapper.firstElementChild ?? wrapper).getBoundingClientRect()
}

// Fixed-viewport coordinates for the portaled popover, pinned to the trigger box.
export function popoverPosition(
  box: Box,
  {
    side,
    align,
    viewport,
  }: {
    side: 'bottom' | 'top'
    align: 'start' | 'end'
    viewport: { width: number; height: number }
  }
): CSSProperties {
  return {
    position: 'fixed',
    ...(side === 'bottom'
      ? { top: box.bottom + GAP }
      : { bottom: viewport.height - box.top + GAP }),
    ...(align === 'end' ? { right: viewport.width - box.right } : { left: box.left }),
  }
}

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
  // The trigger's viewport coordinates. The popover portals to the body and aligns to them with `fixed`
  // (so it is not clipped by a parent's overflow-hidden — a settings card's SettingsList, for example).
  const [box, setBox] = useState<Box | null>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

    // Re-measure the trigger's coordinates (on open, scroll and resize).
  function measure() {
    const el = triggerRef.current
    if (el) setBox(triggerBoxOf(el))
  }

  function toggle() {
    if (open) {
      setOpen(false)
      return
    }
    measure() // secure the coordinates BEFORE opening, so the first paint does not flicker
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      const target = e.target as Node
      // A click on the trigger or inside the portalled content keeps it open (the content is not a DOM child of triggerRef).
      if (triggerRef.current?.contains(target) || contentRef.current?.contains(target)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    // The capture phase keeps up with a scroll in ANY scroll container.
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // `box` is only ever set from a client event, so `window` is read only then (SSR-safe).
  const style: CSSProperties | undefined = box
    ? popoverPosition(box, {
        side,
        align,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      })
    : undefined

  return (
    <div ref={triggerRef} className={cn('relative', className)}>
      {trigger({ open, toggle })}
      {open &&
        style &&
        createPortal(
          <Ctx.Provider value={{ close: () => setOpen(false) }}>
            <div
              ref={contentRef}
              role="menu"
              style={style}
              className={cn(
                // `fixed` class + a z above the Dialog layer (100) — same contract as Combobox: a body-portaled
                // popover must survive globals.css's `body > *:not(.fixed)` clamp AND open inside a modal.
                'fixed z-[110] min-w-[200px] overflow-hidden rounded-lg border border-border bg-popover p-1 text-[13px] shadow-pop',
                'animate-in fade-in-0 zoom-in-95 duration-100',
                side === 'bottom' ? 'origin-top' : 'origin-bottom',
                contentClassName
              )}
            >
              {children}
            </div>
          </Ctx.Provider>,
          document.body
        )}
    </div>
  )
}

// Used to close the menu from a custom composite row outside DropdownItem (a row with a nested action button, which cannot be one button).
export function useDropdownClose(): () => void {
  const ctx = useContext(Ctx)
  return ctx?.close ?? (() => {})
}

export function DropdownItem({
  children,
  onSelect,
  icon,
  trailing,
  tone = 'default',
  className,
}: {
  children: ReactNode
  onSelect?: () => void
  icon?: ReactNode
  // The trailing slot pinned at the row's right end (a selection checkmark, say) — it has to be a SIBLING of the flex-1 label to align on the same row.
  trailing?: ReactNode
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
      {trailing}
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
