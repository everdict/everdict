import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  CircleDot,
  CircleSlash,
  Eye,
  Timer,
  type LucideIcon,
} from 'lucide-react'
import { useTranslations } from 'next-intl'

import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'

import type { IssueStatus } from '../model/schema'
import { issueStatusTone } from '../model/status'

// One icon per status so a list is scannable without reading labels — regressed gets the alarm triangle.
const ICON: Record<IssueStatus, LucideIcon> = {
  backlog: CircleDashed,
  todo: CircleDot,
  in_progress: Timer,
  in_review: Eye,
  done: CheckCircle2,
  cancelled: CircleSlash,
  regressed: AlertTriangle,
}

export function issueStatusIcon(status: IssueStatus): LucideIcon {
  return ICON[status]
}

export function IssueStatusBadge({ status }: { status: IssueStatus }) {
  const t = useTranslations('tracker')
  const Icon = ICON[status]
  return (
    <Badge tone={issueStatusTone(status)}>
      <Icon className="size-3" strokeWidth={2} />
      {t(`issueStatus.${status}`)}
    </Badge>
  )
}

// Icon-only variant for dense rows — the label rides in the title attribute.
export function IssueStatusIcon({
  status,
  className,
}: {
  status: IssueStatus
  className?: string
}) {
  const t = useTranslations('tracker')
  const Icon = ICON[status]
  const label = t(`issueStatus.${status}`)
  const tone = issueStatusTone(status)
  return (
    <span
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex',
        tone === 'success' && 'text-[var(--color-success)]',
        tone === 'danger' && 'text-destructive',
        tone === 'warning' && 'text-[var(--color-warning)]',
        tone === 'info' && 'text-[var(--color-link)]',
        (tone === 'neutral' || tone === 'outline') && 'text-muted-foreground',
        className
      )}
    >
      <Icon className="size-4" strokeWidth={1.75} />
    </span>
  )
}
