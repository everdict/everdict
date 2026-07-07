import { CheckCircle2, CircleSlash, Clock3, Loader2, XCircle } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { RunStatus } from '@/entities/run'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Tooltip } from '@/shared/ui/tooltip'

// superseded is a scorecard-only terminal state (a newer launch on the same PR recalls·replaces it) — neither failure nor success, but neutral.
type PillStatus = RunStatus | 'superseded'

const MAP: Record<
  PillStatus,
  { tone: 'success' | 'danger' | 'info' | 'neutral'; labelKey: string; pulse?: boolean }
> = {
  succeeded: { tone: 'success', labelKey: 'statusSucceeded' },
  failed: { tone: 'danger', labelKey: 'statusFailed' },
  running: { tone: 'info', labelKey: 'statusRunning', pulse: true },
  queued: { tone: 'neutral', labelKey: 'statusQueued' },
  superseded: { tone: 'neutral', labelKey: 'statusSuperseded' },
}

export function StatusPill({ status }: { status: PillStatus }) {
  const t = useTranslations('ui')
  const { tone, labelKey, pulse } = MAP[status]
  return (
    <Badge tone={tone}>
      <span className="relative flex size-1.5">
        {pulse && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
        )}
        <span className={cn('relative inline-flex size-1.5 rounded-full bg-current')} />
      </span>
      {t(labelKey)}
    </Badge>
  )
}

// Status display for list cards — **color icon only**, label in a hover tooltip (card display standard: same principle as UserAvatar).
const ICON_CLASS: Record<PillStatus, string> = {
  succeeded: 'text-[var(--color-success)]',
  failed: 'text-destructive',
  running: 'text-primary',
  queued: 'text-muted-foreground',
  superseded: 'text-faint',
}

export function StatusIcon({ status, className }: { status: PillStatus; className?: string }) {
  const t = useTranslations('ui')
  const label = t(MAP[status].labelKey)
  const Icon =
    status === 'succeeded'
      ? CheckCircle2
      : status === 'failed'
        ? XCircle
        : status === 'running'
          ? Loader2
          : status === 'queued'
            ? Clock3
            : CircleSlash
  return (
    <Tooltip content={label} align="end" className={className}>
      <span aria-label={label} className={cn('inline-flex', ICON_CLASS[status])}>
        <Icon className={cn('size-4', status === 'running' && 'animate-spin')} strokeWidth={1.75} />
      </span>
    </Tooltip>
  )
}
