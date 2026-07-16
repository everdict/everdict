'use client'

import { X } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'

// Reset filters/search button — shown at the end of the filter bar only when a condition is active (dirty).
// Height 32px to align with Input/Combobox. The label comes from the shared `ui` message catalog.
export function ResetFiltersButton({
  onClick,
  className,
}: {
  onClick: () => void
  className?: string
}) {
  const t = useTranslations('ui')
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t('resetFiltersAria')}
      title={t('resetFiltersAria')}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] font-[510] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
        className
      )}
    >
      <X className="size-3.5" />
      {t('resetFilters')}
    </button>
  )
}
