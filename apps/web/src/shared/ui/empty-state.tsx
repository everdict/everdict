import type { ReactNode } from 'react'

// 빈 상태 — Linear st. 8px 라운드 대시 보더, 절제된 아이콘 + 13px 타이틀 + 보조 힌트.
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
