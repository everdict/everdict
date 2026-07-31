import { CheckCircle2, Circle, CircleSlash, Timer, type LucideIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Badge } from '@/shared/ui/badge'

import type { ProjectStatus } from '../model/schema'

const TONE: Record<ProjectStatus, 'neutral' | 'success' | 'info' | 'outline'> = {
  planned: 'outline',
  in_progress: 'info',
  completed: 'success',
  cancelled: 'neutral',
}

const ICON: Record<ProjectStatus, LucideIcon> = {
  planned: Circle,
  in_progress: Timer,
  completed: CheckCircle2,
  cancelled: CircleSlash,
}

export function projectStatusTone(
  status: ProjectStatus
): 'neutral' | 'success' | 'info' | 'outline' {
  return TONE[status]
}

export function projectStatusIcon(status: ProjectStatus): LucideIcon {
  return ICON[status]
}

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const t = useTranslations('tracker')
  const Icon = ICON[status]
  return (
    <Badge tone={TONE[status]}>
      <Icon className="size-3" strokeWidth={2} />
      {t(`projectStatus.${status}`)}
    </Badge>
  )
}
