import type { ReactNode } from 'react'

export function EmptyState({
  title,
  hint,
  icon,
}: {
  title: string
  hint?: string
  icon?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2.5 rounded-xl border border-dashed bg-card/40 px-6 py-14 text-center">
      {icon && <div className="text-muted-foreground/50">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}
