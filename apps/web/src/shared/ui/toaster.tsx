'use client'

import { Toaster as SonnerToaster } from 'sonner'

// Linear st. 토스트(sonner) — 앱 디자인 토큰(popover/border/foreground)으로 스타일해 .dark 클래스 토글에
// 자동으로 라이트/다크 대응한다. 성공 아이콘(체크)만 sonner 기본을 쓰고 배경은 앱 톤으로.
export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      offset={16}
      gap={8}
      toastOptions={{
        style: {
          background: 'var(--color-popover)',
          color: 'var(--color-popover-foreground)',
          border: '1px solid var(--color-border)',
          borderRadius: '0.6rem',
          fontSize: '13px',
          boxShadow: '0 10px 34px -8px rgba(0,0,0,0.28)',
        },
      }}
    />
  )
}
