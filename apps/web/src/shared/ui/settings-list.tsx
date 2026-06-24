import type { ReactNode } from 'react'

import { cn } from '@/shared/lib/utils'

// Linear st. 설정 리스트 — 카드 안에 행을 구분선으로 쌓는다(linear settings-list-view).
// 각 행은 label(좌) · 컨트롤(우)의 가로 배치. 입력은 가로로 늘이지 않고 우측에 간결하게 정렬한다.
// 좁은 화면에서는 label 위 / 컨트롤 아래로 세로 전환.
export function SettingsList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <ul
      className={cn(
        'divide-y divide-border/70 overflow-hidden rounded-lg border bg-card shadow-raise',
        className
      )}
    >
      {children}
    </ul>
  )
}

export function SettingsRow({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: ReactNode
  htmlFor?: string // 우측 컨트롤이 단일 input 일 때 label 연결
  hint?: ReactNode // label 아래 보조 설명(선택)
  children: ReactNode // 우측 컨트롤
}) {
  return (
    <li className="flex min-h-[60px] flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0 space-y-0.5">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-[13px] font-[510] text-foreground">
            {label}
          </label>
        ) : (
          <span className="block text-[13px] font-[510] text-foreground">{label}</span>
        )}
        {hint && <p className="text-[12px] leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:justify-end">{children}</div>
    </li>
  )
}
