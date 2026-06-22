import type { ReactNode } from 'react'

// 페이지 상단 타이틀 블록 — Linear st. 절제된 19px 타이틀 + 13px 보조 설명 + 우측 액션.
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <h1 className="truncate text-[19px] font-[560] leading-tight tracking-[-0.01em] text-foreground">
          {title}
        </h1>
        {description && (
          <p className="text-[13px] leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}
