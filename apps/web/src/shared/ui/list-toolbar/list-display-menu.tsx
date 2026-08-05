'use client'

import type { ComponentType } from 'react'
import { Check, SlidersHorizontal } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import {
  DropdownItem,
  DropdownLabel,
  DropdownMenu,
  DropdownSeparator,
} from '@/shared/ui/dropdown-menu'

// 「표시」 — 리니어의 같은 이름 메뉴: 레이아웃 · 묶기 · 정렬, 그리고 목록에 따라 몇 개의 켜고 끄기.
// 전부 "이걸 어떻게 보고 싶은가"에 답하지 "이 중 어느 것"에는 답하지 않으며, 그래서 아무것도 URL 에 가지
// 않는다 — 보낸 링크가 받는 사람의 화면 배치를 바꾸면 안 된다.
//
// 선택은 그 자리에서 적용된다(서버 왕복 없이). 이슈 목록도 평가 자원 목록들도 이 컴포넌트를 쓴다.

export interface DisplayOption {
  value: string
  label: string
}

export interface LayoutOption extends DisplayOption {
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
}

export interface DisplayToggle {
  key: string
  label: string
  active: boolean
  onToggle: () => void
}

export function ListDisplayMenu({
  groupings,
  grouping,
  onGrouping,
  orders,
  order,
  onOrder,
  layouts,
  layout,
  onLayout,
  toggles,
}: {
  groupings: readonly DisplayOption[]
  grouping: string
  onGrouping: (value: string) => void
  orders: readonly DisplayOption[]
  order: string
  onOrder: (value: string) => void
  // 목록이 실제로 두 가지 모양을 가질 때만 — 보드가 없는 목록에 레이아웃 줄을 세우지 않는다.
  layouts?: readonly LayoutOption[]
  layout?: string
  onLayout?: (value: string) => void
  toggles?: readonly DisplayToggle[]
}) {
  const t = useTranslations('listView')

  return (
    <DropdownMenu
      align="end"
      contentClassName="w-60"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-[12px] font-[510] text-muted-foreground transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground"
        >
          <SlidersHorizontal className="size-3.5" strokeWidth={1.75} aria-hidden />
          {t('display')}
        </button>
      )}
    >
      {/* 레이아웃만 세그먼티드 컨트롤이다: 둘 중 하나를 고르는 일이고, 어느 쪽인지가 한눈에 읽혀야 하는
          유일한 축이다. */}
      {layouts !== undefined && layouts.length > 0 && (
        <>
          <div className="flex gap-1 p-1">
            {layouts.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => onLayout?.(value)}
                aria-pressed={layout === value}
                className={cn(
                  'inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[12px] transition-colors',
                  layout === value
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                )}
              >
                <Icon className="size-3.5" strokeWidth={1.75} aria-hidden />
                {label}
              </button>
            ))}
          </div>
          <DropdownSeparator />
        </>
      )}

      <DropdownLabel>{t('grouping')}</DropdownLabel>
      {groupings.map((option) => (
        <DropdownItem
          key={option.value}
          onSelect={() => onGrouping(option.value)}
          trailing={grouping === option.value ? <Check className="size-3.5" /> : undefined}
        >
          {option.label}
        </DropdownItem>
      ))}
      <DropdownSeparator />

      <DropdownLabel>{t('ordering')}</DropdownLabel>
      {orders.map((option) => (
        <DropdownItem
          key={option.value}
          onSelect={() => onOrder(option.value)}
          trailing={order === option.value ? <Check className="size-3.5" /> : undefined}
        >
          {option.label}
        </DropdownItem>
      ))}

      {toggles !== undefined && toggles.length > 0 && (
        <>
          <DropdownSeparator />
          {toggles.map((option) => (
            <DropdownItem
              key={option.key}
              onSelect={option.onToggle}
              trailing={option.active ? <Check className="size-3.5" /> : undefined}
            >
              {option.label}
            </DropdownItem>
          ))}
        </>
      )}
    </DropdownMenu>
  )
}
