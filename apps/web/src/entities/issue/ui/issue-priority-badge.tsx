import { Minus, SignalHigh, SignalLow, SignalMedium, TriangleAlert, type LucideIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'

import type { IssuePriority } from '../model/schema'

// 상태 아이콘과 같은 문법: 우선순위도 한 눈에 훑는 축이라 아이콘이 먼저다. 리니어처럼 신호 세기(막대)로 급함을
// 표현하고, 긴급만 경고 삼각형으로 따로 세운다 — "지금 멈추고 봐야 하는가"는 정도가 아니라 종류가 다르다.
const ICON: Record<IssuePriority, LucideIcon> = {
  urgent: TriangleAlert,
  high: SignalHigh,
  medium: SignalMedium,
  low: SignalLow,
  none: Minus,
}

// 색은 긴급에만 준다. 다섯 단계를 전부 물들이면 목록이 신호가 아니라 무지개가 되고, 정작 급한 줄이 묻힌다.
function toneClass(priority: IssuePriority): string {
  if (priority === 'urgent') return 'text-destructive'
  if (priority === 'none') return 'text-faint'
  return 'text-muted-foreground'
}

export function issuePriorityIcon(priority: IssuePriority): LucideIcon {
  return ICON[priority]
}

export function IssuePriorityBadge({ priority }: { priority: IssuePriority }) {
  const t = useTranslations('tracker')
  const Icon = ICON[priority]
  return (
    <Badge tone={priority === 'urgent' ? 'danger' : 'outline'}>
      <Icon className="size-3" strokeWidth={2} />
      {t(`issuePriority.${priority}`)}
    </Badge>
  )
}

// 조밀한 행용 아이콘 단독 변형 — 라벨은 title 로 간다(상태 아이콘과 같은 처리).
export function IssuePriorityIcon({
  priority,
  className,
}: {
  priority: IssuePriority
  className?: string
}) {
  const t = useTranslations('tracker')
  const Icon = ICON[priority]
  const label = t(`issuePriority.${priority}`)
  return (
    <span
      title={label}
      aria-label={label}
      className={cn('inline-flex', toneClass(priority), className)}
    >
      <Icon className="size-4" strokeWidth={1.75} />
    </span>
  )
}
