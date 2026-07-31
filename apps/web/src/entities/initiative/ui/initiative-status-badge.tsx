import { CheckCircle2, CircleSlash, Rocket, type LucideIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Badge } from '@/shared/ui/badge'

import type { InitiativeStatus } from '../model/schema'

const TONE: Record<InitiativeStatus, 'neutral' | 'success' | 'info'> = {
  active: 'info',
  completed: 'success',
  cancelled: 'neutral',
}

const ICON: Record<InitiativeStatus, LucideIcon> = {
  active: Rocket,
  completed: CheckCircle2,
  cancelled: CircleSlash,
}

export function initiativeStatusTone(status: InitiativeStatus): 'neutral' | 'success' | 'info' {
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
