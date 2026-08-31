'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { rowOffsets, virtualWindowOf } from '@/shared/lib/virtual-window'

// The window that lets a browser carry a list of hundreds. Only the rows crossing the scroll area are drawn;
// above and below them two spacers hold the height — so the DOM tracks the screen, not the collection.
//
// Why it was needed: one scorecard holds hundreds of cases. Drawn whole, the first paint stands thousands of
// nodes, and from then on a single keystroke or one filter re-creates all of them. A window cuts both costs
// down to what is on screen.
//
// It has ONE rule: **a row's real height must equal what `heightOf` said.** The spacers are computed from
// that number, so a row that grows by wrapping desyncs the scroll position from the rows being drawn. That is
// why lists using this window keep rows to one fixed-height line (overflow truncates) — and the constraint
// itself is what makes hundreds of rows scannable.
//
// Spacers rather than absolute positioning: rows stay in normal flow, so hover, focus rings and dividers are
// ordinary CSS doing ordinary things. Absolute positioning would buy this list nothing.
// The arithmetic itself lives in `shared/lib/virtual-window` — the kind of code that raises nothing when it is
// wrong and only draws the wrong screen, so it is checked outside the component.

// The viewport height assumed before measurement (first render · SSR). ResizeObserver reports the real one
// right after mount.
const ASSUMED_VIEWPORT_PX = 900

export function VirtualList<T>({
  items,
  keyOf,
  heightOf,
  maxHeight,
  overscan = 6,
  resetKey,
  className,
  children,
}: {
  items: readonly T[]
  keyOf: (item: T, index: number) => string
  // The height (px) this row occupies. It must equal the height actually drawn (the rule above).
  heightOf: (item: T, index: number) => number
  // The scroll area's max height as a CSS length. Shorter content simply stands at its own height, unscrolled.
  maxHeight: string
  overscan?: number
  // A marker that the list's contents changed (filter · search · ordering). On a change the window returns to
  // the top: a filter applied while you were at row 500 leaves that position pointing at nothing.
  resetKey?: string
  className?: string
  children: (item: T, index: number) => ReactNode
}) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(ASSUMED_VIEWPORT_PX)

  // The scroll offset moves into state once per frame — scroll events arrive faster than frames, and every
  // value in between paints in the same frame anyway.
  const frame = useRef<number | undefined>(undefined)
  const onScroll = useCallback(() => {
    if (frame.current !== undefined) return
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined
      setScrollTop(viewportRef.current?.scrollTop ?? 0)
    })
  }, [])
  useEffect(
    () => () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    },
    []
  )

  useEffect(() => {
    const el = viewportRef.current
    if (el === null) return
    const measure = () => setViewport(el.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const el = viewportRef.current
    if (el === null) return
    el.scrollTop = 0
    setScrollTop(0)
  }, [resetKey])

  const offsets = useMemo(
    () => rowOffsets(items.length, (index) => heightOf(items[index], index)),
    [items, heightOf]
  )
  // Not named `window` — shadowing the global is a bad idea anywhere and worse inside a scroll component.
  const slice = virtualWindowOf(offsets, scrollTop, viewport, overscan)

  return (
    <div ref={viewportRef} onScroll={onScroll} style={{ maxHeight }} className={className}>
      <div style={{ height: slice.top }} aria-hidden />
      {/* A Fragment carries the key and nothing else — a wrapper div per row would put the row's height,
          divider and hover behind one more element, moving this window's only rule (drawn height = heightOf)
          a layer away. The scroll area itself takes no tabIndex: rows are already focusable, so a keyboard
          reaches them, and the browser scrolls this region to follow the focus. */}
      {items.slice(slice.first, slice.last).map((item, offset) => {
        const index = slice.first + offset
        return <Fragment key={keyOf(item, index)}>{children(item, index)}</Fragment>
      })}
      <div style={{ height: slice.bottom }} aria-hidden />
    </div>
  )
}
