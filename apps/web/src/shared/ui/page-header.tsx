import type { ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'

// Page top title block — Linear st. understated 19px title + 13px secondary description + right-side actions.
export function PageHeader({
  title,
  description,
  actions,
  wrapTitle = false,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  // 제목이 사람이 쓴 자유 텍스트일 때(이슈 제목 등) 켠다 — 잘라내면 읽을 방법이 없어지므로 줄바꿈으로 전부 보여준다.
  // 기본값은 잘라내기: 목록/식별자성 제목은 한 줄로 고정되는 편이 낫다.
  wrapTitle?: boolean
}) {
  return (
    <div className="space-y-1">
      {/* Title row: title left + actions top-right. The description flows full-width on the row below.
          Mobile: the title keeps a min width (basis-52) so it never gets squashed; when narrow, actions wrap to the next line. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h1
          className={cn(
            'min-w-0 max-w-full flex-1 basis-52 text-[19px] font-[560] leading-tight tracking-[-0.01em] text-foreground',
            wrapTitle ? 'break-words' : 'truncate'
          )}
        >
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
