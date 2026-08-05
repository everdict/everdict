'use client'

import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'

import { cn } from '@/shared/lib/utils'

// 묶인 목록의 한 그룹 — 접히는 머리글(이름 + 개수)과 그 아래 행들. 개수는 이 그룹이 **실제로 든** 행 수다:
// 컬렉션 전체가 브라우저에 있으므로 헤더의 숫자와 그 아래가 어긋날 방법이 없다(그룹마다 한 장씩 서버에서
// 받아 오는 이슈 목록이 서버 집계를 따로 읽어야 하는 것과 다른 점이다).
export function ListGroup({
  label,
  count,
  children,
}: {
  label: ReactNode
  count: number
  children: ReactNode
}) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <section className="space-y-1.5">
      <button
        type="button"
        onClick={() => setCollapsed((prev) => !prev)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-[12px] font-[560] text-foreground transition-colors hover:bg-accent/60"
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-faint transition-transform duration-150',
            !collapsed && 'rotate-90'
          )}
          strokeWidth={2.25}
          aria-hidden
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{count}</span>
      </button>
      {!collapsed && <div className="space-y-1.5">{children}</div>}
    </section>
  )
}

// 묶여 있으면 그룹, 아니면 그냥 행들. 목록이 「묶지 않음」일 때 이름표 없는 그룹 껍데기를 세우지 않기 위한
// 것뿐이다 — 이름 없는 머리글은 목록의 첫 줄이 무엇인지 헷갈리게 만든다.
export function ListSection({
  grouped,
  label,
  count,
  children,
}: {
  grouped: boolean
  label: ReactNode
  count: number
  children: ReactNode
}) {
  if (!grouped) return <div className="space-y-2">{children}</div>
  return (
    <ListGroup label={label} count={count}>
      {children}
    </ListGroup>
  )
}
