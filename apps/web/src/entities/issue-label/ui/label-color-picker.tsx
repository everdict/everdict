'use client'

import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'

import { ISSUE_LABEL_COLORS, type IssueLabelColor } from '../model/schema'
import { LabelDot } from './label-chip'

// A colour is picked only from a CLOSED palette — allow hex input and anyone can make a label invisible in dark mode (the same rule as the
// charts: no invented colours). There are two surfaces that create labels (the settings label manager, the picker on the issue screens), so what
// they pick FROM has to be one thing too — `size="sm"` is for a narrow popover.
export function LabelColorPicker({
  value,
  onChange,
  labelledBy,
  ariaLabel,
  size = 'md',
}: {
  value: IssueLabelColor
  onChange: (next: IssueLabelColor) => void
  labelledBy?: string
  ariaLabel?: string
  size?: 'sm' | 'md'
}) {
  const t = useTranslations('tracker')
  return (
    <div
      role="radiogroup"
      {...(labelledBy !== undefined ? { 'aria-labelledby': labelledBy } : {})}
      {...(ariaLabel !== undefined ? { 'aria-label': ariaLabel } : {})}
      className={cn('flex flex-wrap', size === 'sm' ? 'gap-1' : 'gap-1.5')}
    >
      {ISSUE_LABEL_COLORS.map((color) => {
        const name = t(`labelColor.${color}`)
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={color === value}
            aria-label={name}
            title={name}
            onClick={() => onChange(color)}
            className={cn(
              'grid place-items-center rounded-md border transition-colors',
              size === 'sm' ? 'size-6' : 'size-7',
              color === value
                ? 'border-primary bg-primary/10'
                : 'border-border hover:border-border-strong'
            )}
          >
            <LabelDot color={color} className={size === 'sm' ? 'size-2.5' : 'size-3'} />
          </button>
        )
      })}
    </div>
  )
}
