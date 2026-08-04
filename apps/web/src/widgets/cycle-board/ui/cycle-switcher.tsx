'use client'

import { useRouter } from 'next/navigation'
import { Check, ChevronDown, List } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cycleLabel, type CycleState } from '@/entities/cycle'
import { cn } from '@/shared/lib/utils'
import { DropdownItem, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'

export interface CycleSwitcherOption {
  number: number
  label: string
  state: CycleState
  href: string
}

// 어느 이터레이션을 보고 있는가 — 제목 자체가 스위처다(리니어의 동선). 사이클 목록은 한 팀의 것이라 길지 않으니
// 드롭다운 하나로 충분하고, 전부 보려면 마지막 줄이 인덱스로 보낸다.
export function CycleSwitcher({
  current,
  options,
  indexHref,
}: {
  current: { number: number; name?: string }
  options: CycleSwitcherOption[]
  indexHref: string
}) {
  const t = useTranslations('cyclesPage')
  const tracker = useTranslations('tracker')
  const router = useRouter()

  return (
    <DropdownMenu
      align="start"
      contentClassName="w-60 p-1"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={t('switcherLabel')}
          className="inline-flex min-w-0 items-center gap-1.5 rounded text-[19px] font-[560] leading-tight tracking-[-0.01em] text-foreground transition-colors hover:text-[var(--color-link)]"
        >
          <span className="truncate">{cycleLabel(current)}</span>
          <ChevronDown className="size-4 shrink-0 text-faint" />
        </button>
      )}
    >
      <div className="max-h-72 overflow-y-auto">
        {options.map((option) => (
          <DropdownItem
            key={option.number}
            onSelect={() => router.push(option.href)}
            {...(option.number === current.number ? { trailing: <Check className="size-3.5" /> } : {})}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  'truncate',
                  option.number === current.number && 'font-[560] text-foreground'
                )}
              >
                {option.label}
              </span>
              {/* 진행 중만 색을 갖는다 — 예정과 완료는 배경이지 신호가 아니다. */}
              <span
                className={cn(
                  'shrink-0 text-[11px]',
                  option.state === 'active' ? 'text-[var(--color-link)]' : 'text-faint'
                )}
              >
                {tracker(`cycleState.${option.state}`)}
              </span>
            </span>
          </DropdownItem>
        ))}
      </div>
      <DropdownSeparator />
      <DropdownItem icon={<List className="size-3.5" />} onSelect={() => router.push(indexHref)}>
        {t('viewAll')}
      </DropdownItem>
    </DropdownMenu>
  )
}
