import { CheckCircle2, CircleSlash, Clock3, Loader2, XCircle } from 'lucide-react'

import type { RunStatus } from '@/entities/run'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Tooltip } from '@/shared/ui/tooltip'

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

// 목록 카드용 상태 표기 — **색상 아이콘만**, 라벨은 호버 툴팁(카드 표기 표준: UserAvatar 와 동일 원칙).
const ICON_CLASS: Record<PillStatus, string> = {
  succeeded: 'text-[var(--color-success)]',
  failed: 'text-destructive',
  running: 'text-primary',
  queued: 'text-muted-foreground',
  superseded: 'text-faint',
}

export function StatusIcon({ status, className }: { status: PillStatus; className?: string }) {
  const { label } = MAP[status]
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
