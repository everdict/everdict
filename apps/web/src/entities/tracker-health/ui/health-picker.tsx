'use client'

import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'

import { TRACKER_HEALTH, type TrackerHealth } from '../model/schema'

// Picking a verdict. Colour is given to off-track and at-risk alone: colouring all three turns "on track" into green noise.
const TONE: Record<TrackerHealth, string> = {
  on_track: 'border-border text-muted-foreground',
  at_risk: 'border-[var(--color-warning)]/40 text-[var(--color-warning)]',
  off_track: 'border-destructive/40 text-destructive',
}

// A project update and an initiative update use the SAME row — draw one vocabulary twice and the two eventually differ.
export function HealthPicker({
  value,
  onChange,
}: {
  value: TrackerHealth
  onChange: (health: TrackerHealth) => void
}) {
  const t = useTranslations('tracker')
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {TRACKER_HEALTH.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={value === option}
          className={cn(
            'rounded-full border px-2.5 py-0.5 text-[12px] transition-colors',
            value === option
              ? TONE[option]
              : 'border-border text-muted-foreground hover:text-foreground',
            value === option && 'bg-accent'
          )}
        >
          {t(`health.${option}`)}
        </button>
      ))}
    </div>
  )
}
