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

// "Display" — Linear's menu of the same name: layout · grouping · ordering, plus a few toggles depending on the list.
// All of it answers "how do I want to SEE this" rather than "which of these", which is why none of it goes into the URL —
// a link you send must not rearrange the recipient's screen.
//
// A choice applies on the spot (with no server round trip). Both the issue list and the evaluation resource lists use this component.

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
  // Only when the list genuinely has two shapes — no layout row is stood up on a list with no board.
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
      {/* Only the layout is a segmented control: it picks one of two, and it is the only axis where WHICH one has to be readable at a glance. */}
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
