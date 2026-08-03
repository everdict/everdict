'use client'

import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'

import { TRACKER_HEALTH, type TrackerHealth } from '../model/schema'

// 판정 고르기. 색은 이탈/위험에만 준다: 세 단계를 다 물들이면 "정상"이 초록 소음이 된다.
const TONE: Record<TrackerHealth, string> = {
  on_track: 'border-border text-muted-foreground',
  at_risk: 'border-[var(--color-warning)]/40 text-[var(--color-warning)]',
  off_track: 'border-destructive/40 text-destructive',
}

// 프로젝트 업데이트와 이니셔티브 업데이트가 같은 줄을 쓴다 — 같은 어휘를 두 번 그리면 언젠가 달라진다.
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
