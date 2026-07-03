import type { RunStatus } from '@/entities/run'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'

// superseded 는 스코어카드 전용 종결(같은 PR 의 더 새 발사가 회수·대체) — 실패도 성공도 아닌 중립.
type PillStatus = RunStatus | 'superseded'

const MAP: Record<
  PillStatus,
  { tone: 'success' | 'danger' | 'info' | 'neutral'; label: string; pulse?: boolean }
> = {
  succeeded: { tone: 'success', label: '성공' },
  failed: { tone: 'danger', label: '실패' },
  running: { tone: 'info', label: '실행중', pulse: true },
  queued: { tone: 'neutral', label: '대기' },
  superseded: { tone: 'neutral', label: '대체됨' },
}

export function StatusPill({ status }: { status: PillStatus }) {
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
