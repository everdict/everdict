import type { ReactNode } from 'react'

// Section title + right-side action (e.g. a "view all" link). Linear st. 14px semibold.
export function SectionHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-[14px] font-[560] tracking-[-0.01em] text-foreground">{title}</h2>
      {action ? <div className="flex items-center gap-2">{action}</div> : null}
    </div>
  )
}
