import { useTranslations } from 'next-intl'

import { Badge } from '@/shared/ui/badge'

import type { TrackerHealth } from '../model/schema'

// Colour is given to off-track and at-risk alone: colouring all three turns "on track" into green noise and buries the one row that has to be read.
const TONE: Record<TrackerHealth, 'success' | 'warning' | 'danger'> = {
  on_track: 'success',
  at_risk: 'warning',
  off_track: 'danger',
}

export function healthTone(health: TrackerHealth): 'success' | 'warning' | 'danger' {
  return TONE[health]
}

// Projects and initiatives use the SAME badge — the same vocabulary looking different per screen reads as a different verdict.
export function HealthBadge({ health }: { health: TrackerHealth }) {
  const t = useTranslations('tracker')
  return <Badge tone={TONE[health]}>{t(`health.${health}`)}</Badge>
}
