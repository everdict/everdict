import type { ReactNode } from 'react'

// Empty state — Linear st. 8px round dashed border, understated icon + 13px title + secondary hint.
export function EmptyState({
  title,
  hint,
  icon,
  action,
}: {
  title: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 rounded-lg border border-dashed bg-card/40 px-6 py-12 text-center">
      {icon && (
        <div className="grid size-9 place-items-center rounded-lg bg-elevated text-muted-foreground/70 [&_svg]:size-[18px]">
          {icon}
        </div>
      )}
      <p className="text-[13px] font-[510] text-foreground">{title}</p>
      {hint && <p className="max-w-sm text-[12px] leading-relaxed text-muted-foreground">{hint}</p>}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  )
}
