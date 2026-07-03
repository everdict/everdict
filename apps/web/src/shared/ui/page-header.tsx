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
    <div className="space-y-1">
      {/* 타이틀 행: 타이틀 좌 + 액션 상단 우측. 설명은 아래 행에서 전체 폭으로 흐른다.
          모바일: 타이틀이 최소폭(basis-52)을 지켜 절대 뭉개지지 않고, 좁으면 액션이 다음 줄로 wrap. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h1 className="min-w-0 max-w-full flex-1 basis-52 truncate text-[19px] font-[560] leading-tight tracking-[-0.01em] text-foreground">
          {title}
        </h1>
        {actions && (
          <div className="flex max-w-full flex-wrap items-center justify-end gap-2">{actions}</div>
        )}
      </div>
      {description && (
        <p className="text-[13px] leading-relaxed text-muted-foreground">{description}</p>
      )}
    </div>
  )
}
