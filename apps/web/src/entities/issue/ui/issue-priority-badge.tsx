import { Minus, SignalHigh, SignalLow, SignalMedium, TriangleAlert, type LucideIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'

import type { IssuePriority } from '../model/schema'

// The same grammar as the status icon: priority is an axis you sweep at a glance too, so the icon comes first. Urgency is expressed as signal
// strength (bars) as in Linear, with only `urgent` standing apart as a warning triangle — "do I stop and look now" differs in KIND, not degree.
const ICON: Record<IssuePriority, LucideIcon> = {
  urgent: TriangleAlert,
  high: SignalHigh,
  medium: SignalMedium,
  low: SignalLow,
  none: Minus,
}

// Colour is given to `urgent` alone. Colouring all five levels turns the list into a rainbow rather than a signal, and buries the row that is actually urgent.
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

// The icon-only variant for dense rows — the label goes into `title` (the same treatment as the status icon).
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
