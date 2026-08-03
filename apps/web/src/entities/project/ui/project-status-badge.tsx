import {
  CheckCircle2,
  Circle,
  CircleDashed,
  CircleSlash,
  PauseCircle,
  Timer,
  type LucideIcon,
} from 'lucide-react'
import { useTranslations } from 'next-intl'

import { Badge } from '@/shared/ui/badge'

import type { ProjectStatus } from '../model/schema'

const TONE: Record<ProjectStatus, 'neutral' | 'success' | 'info' | 'outline'> = {
  // 백로그는 "아직 아무것도 아님", 멈춤은 "버린 건 아니지만 지금은 안 움직임" — 둘 다 진행 중처럼 보이면 안 된다.
  backlog: 'neutral',
  planned: 'outline',
  paused: 'outline',
  in_progress: 'info',
  completed: 'success',
  cancelled: 'neutral',
}

const ICON: Record<ProjectStatus, LucideIcon> = {
  backlog: CircleDashed,
  planned: Circle,
  paused: PauseCircle,
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
