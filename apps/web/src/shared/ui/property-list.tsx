import type { ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'

// Linear st. 속성 패널 — 상세 화면 오른쪽 열에 "이 레코드가 무엇인지"를 한 줄씩 모아 둔다.
// SettingsList 와 다른 물건이다: 저건 설정 폼의 넓은 divided row, 이건 좁은 사이드바의 조밀한 읽기용 행이라
// 카드도 구분선도 없이 라벨(왼쪽 고정폭) · 값(오른쪽 흐름)만 남긴다. 값이 없는 행은 아예 렌더하지 않는다
// (빈 섹션 숨김 규칙) — "없음" 자리표시자는 패널을 읽을 게 없는 목록으로 만든다.
export function PropertyList({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn('space-y-2.5', className)}>{children}</dl>
}

export function PropertyRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <dt className="w-[4.5rem] shrink-0 pt-1 text-[12px] leading-tight text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 text-[12.5px] leading-tight text-foreground">{children}</dd>
    </div>
  )
}
