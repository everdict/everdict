import type { RunStatus } from '@/entities/run'
import { Badge } from '@/shared/ui/badge'

const MAP: Record<RunStatus, { tone: 'success' | 'danger' | 'info' | 'neutral'; label: string }> = {
  succeeded: { tone: 'success', label: '성공' },
  failed: { tone: 'danger', label: '실패' },
  running: { tone: 'info', label: '실행중' },
  queued: { tone: 'neutral', label: '대기' },
}

export function StatusPill({ status }: { status: RunStatus }) {
  const { tone, label } = MAP[status]
  return (
    <Badge tone={tone}>
      <span className="mr-1 inline-block size-1.5 rounded-full bg-current opacity-70" />
      {label}
    </Badge>
  )
}
