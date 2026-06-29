import type { RunStatus } from '@/entities/run'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'

const MAP: Record<
  RunStatus,
  { tone: 'success' | 'danger' | 'info' | 'neutral'; label: string; pulse?: boolean }
> = {
  succeeded: { tone: 'success', label: '성공' },
  failed: { tone: 'danger', label: '실패' },
  running: { tone: 'info', label: '실행중', pulse: true },
  queued: { tone: 'neutral', label: '대기' },
}

export function StatusPill({ status }: { status: RunStatus }) {
  const { tone, label, pulse } = MAP[status]
  return (
    <Badge tone={tone}>
      <span className="relative flex size-1.5">
        {pulse && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
        )}
        <span className={cn('relative inline-flex size-1.5 rounded-full bg-current')} />
      </span>
      {label}
    </Badge>
  )
}
