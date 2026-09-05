import type { ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'

// A Linear-style attribute panel — it collects "what this record IS", one row at a time, in a detail screen's right column.
// It is a DIFFERENT thing from SettingsList: that is the wide divided row of a settings form, this is the dense reading row of a narrow sidebar,
// so it keeps only a label (fixed width, left) and a value (flowing, right) with no card and no separators. A row with no value is not rendered
// at all (the empty-section hiding rule) — a "none" placeholder turns the panel into a list with nothing to read.
export function PropertyList({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn('space-y-2.5', className)}>{children}</dl>
}

export function PropertyRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <dt className="w-[4.5rem] shrink-0 pt-1 text-[12px] leading-tight text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-[12.5px] leading-tight text-foreground">{children}</dd>
    </div>
  )
}
