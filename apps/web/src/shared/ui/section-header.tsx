import type { ReactNode } from 'react'

// 섹션 제목 + 우측 액션(예: "전체 보기" 링크). Linear st. 14px 세미볼드.
export function SectionHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-[14px] font-[560] tracking-[-0.01em] text-foreground">{title}</h2>
      {action ? <div className="flex items-center gap-2">{action}</div> : null}
    </div>
  )
}
