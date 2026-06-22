import type { ReactNode } from 'react'

// 섹션 제목 + 우측 액션(예: "전체 보기" 링크) 공통화.
// 페이지 내 <h2 ...> + 링크 반복 패턴을 대체한다.
export function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
      {action ? <div className="flex items-center gap-2">{action}</div> : null}
    </div>
  )
}
