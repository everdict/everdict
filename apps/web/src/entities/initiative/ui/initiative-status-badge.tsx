import { CheckCircle2, CircleDashed, CircleSlash, Target, type LucideIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Badge } from '@/shared/ui/badge'

import type { InitiativeStatus } from '../model/schema'

const TONE: Record<InitiativeStatus, 'neutral' | 'success' | 'info' | 'outline'> = {
  // 계획됨은 "아직 아무 일도 시작 안 함" — 진행 중과 같은 색을 주면 구상이 일처럼 보인다.
  planned: 'outline',
  active: 'info',
  completed: 'success',
  cancelled: 'neutral',
}

const ICON: Record<InitiativeStatus, LucideIcon> = {
  planned: CircleDashed,
  active: Target,
  completed: CheckCircle2,
  cancelled: CircleSlash,
}

export function initiativeStatusTone(
  status: InitiativeStatus
): 'neutral' | 'success' | 'info' | 'outline' {
  return TONE[status]
}

export function initiativeStatusIcon(status: InitiativeStatus): LucideIcon {
  return ICON[status]
}

export function InitiativeStatusBadge({ status }: { status: InitiativeStatus }) {
  const t = useTranslations('tracker')
  const Icon = ICON[status]
  return (
    <Badge tone={TONE[status]}>
      <Icon className="size-3" strokeWidth={2} />
      {t(`initiativeStatus.${status}`)}
    </Badge>
  )
}
