'use client'

import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

import { cn } from '@/shared/lib/utils'

// One group of a grouped list — a collapsible header (the name plus a count) with its rows beneath. The count is how many rows this group
// **actually holds**: the whole collection is in the browser, so there is no way for the header's number to disagree with what is under it
// (unlike the issue list, which fetches one page per group from the server and has to read a server aggregate separately).
export function ListGroup({
  label,
  count,
  children,
}: {
  label: ReactNode
  count: number
  children: ReactNode
}) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <section className="space-y-1.5">
      <button
        type="button"
        onClick={() => setCollapsed((prev) => !prev)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-[12px] font-[560] text-foreground transition-colors hover:bg-accent/60"
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-faint transition-transform duration-150',
            !collapsed && 'rotate-90'
          )}
          strokeWidth={2.25}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{count}</span>
      </button>
      {!collapsed && <div className="space-y-1.5">{children}</div>}
    </section>
  )
}

// The same header, CONTROLLED and of a declared height — for a list that draws a window
// (`shared/ui/virtual-list`). A window needs a FLAT row array, or a collapsed group would still stand its 500
// rows to be measured, so the collapsed state has to belong to the list rather than to this component. The
// height is a constant here for the same reason the rows' is: the window computes its spacers from it.
export const LIST_GROUP_ROW_HEIGHT_PX = 34

export function ListGroupRow({
  label,
  count,
  collapsed,
  onToggle,
  className,
}: {
  label: ReactNode
  count: number
  collapsed: boolean
  onToggle: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      style={{ height: LIST_GROUP_ROW_HEIGHT_PX }}
      className={cn(
        'flex w-full items-center gap-1.5 px-1 text-left text-[12px] font-[560] text-foreground transition-colors hover:bg-accent/60',
        className
      )}
    >
      <ChevronRight
        className={cn(
          'size-3 shrink-0 text-faint transition-transform duration-150',
          !collapsed && 'rotate-90'
        )}
        strokeWidth={2.25}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground">{count}</span>
    </button>
  )
}

// Grouped, groups; otherwise just rows. It exists only so that a list set to "ungrouped" does not stand up a nameless group shell —
// a header with no name makes it unclear what the list's first row even is.
export function ListSection({
  grouped,
  label,
  count,
  children,
}: {
  grouped: boolean
  label: ReactNode
  count: number
  children: ReactNode
}) {
  if (!grouped) return <div className="space-y-2">{children}</div>
  return (
    <ListGroup label={label} count={count}>
      {children}
    </ListGroup>
  )
}
