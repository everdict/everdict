import { useTranslations } from 'next-intl'

import { Badge } from '@/shared/ui/badge'

import type { TrackerHealth } from '../model/schema'

// 색은 이탈/위험에만 준다: 세 단계를 다 물들이면 "정상"이 초록 소음이 되어, 정작 봐야 할 한 줄이 묻힌다.
const TONE: Record<TrackerHealth, 'success' | 'warning' | 'danger'> = {
  on_track: 'success',
  at_risk: 'warning',
  off_track: 'danger',
}

export function healthTone(health: TrackerHealth): 'success' | 'warning' | 'danger' {
  return TONE[health]
}

// 프로젝트와 이니셔티브가 같은 배지를 쓴다 — 같은 어휘가 화면마다 달라 보이면 다른 판정으로 읽힌다.
export function HealthBadge({ health }: { health: TrackerHealth }) {
  const t = useTranslations('tracker')
  return <Badge tone={TONE[health]}>{t(`health.${health}`)}</Badge>
}
