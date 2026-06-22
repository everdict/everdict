import type { ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/shared/lib/utils'

// 페이지 전반의 에러/안내 박스 공통화 (기존 border-destructive/30 bg-destructive/5 … 반복 대체).
// 본문 텍스트는 tone 색을 상속하고, 보조 설명은 hint(muted)로 분리한다.
const calloutVariants = cva('rounded-xl border px-4 py-3 text-sm', {
  variants: {
    tone: {
      danger: 'border-destructive/30 bg-destructive/5 text-destructive',
      warning:
        'border-[var(--color-warning)]/30 bg-[var(--color-warning)]/8 text-[var(--color-warning)]',
      info: 'border-primary/25 bg-primary/5 text-foreground',
      muted: 'border-border bg-muted/40 text-muted-foreground',
    },
  },
  defaultVariants: { tone: 'info' },
})

export function Callout({
  tone,
  children,
  hint,
  className,
}: VariantProps<typeof calloutVariants> & {
  children: ReactNode
  hint?: ReactNode
  className?: string
}) {
  return (
    <div className={cn(calloutVariants({ tone }), className)}>
      <div>{children}</div>
      {hint ? <div className="mt-1 text-muted-foreground">{hint}</div> : null}
    </div>
  )
}
