import type { ReactNode } from 'react'

// Page top title block — Linear st. understated 19px title + 13px secondary description + right-side actions.
// 자유 텍스트 제목(이슈처럼 제목 자체가 본문인 화면)은 이 원자를 쓰지 않는다 — 그런 화면은 제목이 페이지
// 이름이 아니라 내용이라 자기 크기의 h1 을 직접 세운다(app/[workspace]/issues/[id]).
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
      {/* Title row: title left + actions top-right. The description flows full-width on the row below.
          Mobile: the title keeps a min width (basis-52) so it never gets squashed; when narrow, actions wrap to the next line. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h1 className="min-w-0 max-w-full flex-1 basis-52 truncate text-[19px] font-[560] leading-tight tracking-[-0.01em] text-foreground">
          {title}
        </h1>
        {actions && (
          <div className="flex max-w-full flex-wrap items-center justify-end gap-2">{actions}</div>
        )}
      </div>
      {description && (
        <p className="break-words text-[13px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  )
}
