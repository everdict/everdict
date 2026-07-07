import type { ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'

// Linear st. settings list — stack rows separated by dividers inside a card (linear settings-list-view).
// Each row lays out label (left) · control (right) horizontally. The input isn't stretched wide; it aligns compactly on the right.
// On narrow screens, switch to vertical: label on top / control below.
export function SettingsList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <ul
      className={cn(
        'divide-y divide-border/70 overflow-hidden rounded-lg border bg-card shadow-raise',
        className
      )}
    >
      {children}
    </ul>
  )
}

export function SettingsRow({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: ReactNode
  htmlFor?: string // links the label when the right-side control is a single input
  hint?: ReactNode // secondary description below the label (optional)
  children: ReactNode // right-side control
}) {
  return (
    <li className="flex min-h-[60px] flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0 space-y-0.5">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-[13px] font-[510] text-foreground">
            {label}
          </label>
        ) : (
          <span className="block text-[13px] font-[510] text-foreground">{label}</span>
        )}
        {hint && <p className="text-[12px] leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:justify-end">{children}</div>
    </li>
  )
}
