'use client'

import type { ReactNode } from 'react'
import { usePathname } from 'next/navigation'

// 라우트 전환마다 본문을 staggered reveal(.rise)로 재생 — pathname 을 key 로 두면 페이지 변경 시 remount 되어
// CSS 진입 애니메이션이 다시 실행된다(frontend-design: 잘 조율된 page-load 순간). reduced-motion 은 globals 에서 비활성.
export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  return (
    <div key={pathname} className="rise">
      {children}
    </div>
  )
}
