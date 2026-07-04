'use client'

import { useState } from 'react'
import Link from 'next/link'
import { BarChart3, History, Sparkles } from 'lucide-react'

import { fmtDateTimeFull, fmtTimeAgo } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'

export interface Actor {
  name: string
  avatarUrl?: string
  known: boolean
}
// 데이터셋 활동 이벤트(댓글은 별도 CommentThread) — 생성 + 스코어카드 실행.
export type ActivityItem =
  | { kind: 'created'; at: string; actor: Actor }
  | {
      kind: 'scorecard'
      at: string
      actor: Actor
      scorecardId: string
      harnessId: string
      harness: string
      status: string
      passRate: number | null
    }

const INITIAL = 10
const STEP = 20

const STATUS_TONE: Record<string, string> = {
  succeeded: 'text-[var(--color-success)]',
  failed: 'text-[var(--color-danger)]',
  running: 'text-[var(--color-warning)]',
  queued: 'text-muted-foreground',
  superseded: 'text-faint',
}
const STATUS_LABEL: Record<string, string> = {
  succeeded: '성공',
  failed: '실패',
  running: '실행 중',
  queued: '대기',
  superseded: '대체됨',
}

// 데이터셋 활동 히스토리(이벤트) — 시간순, 최근 10개만 + '이전 이력 보기'. 댓글/논의는 별도 스레드.
export function ActivityTimeline({
  workspace,
  items,
}: {
  workspace: string
  items: ActivityItem[]
}) {
  const [shown, setShown] = useState(INITIAL)
  const start = Math.max(0, items.length - shown)
  const visible = items.slice(start)
  const hidden = start

  return (
    <div className="space-y-3">
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShown((s) => s + STEP)}
          className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1.5 text-[12px] font-[510] text-muted-foreground shadow-raise transition-colors hover:border-border-strong hover:text-foreground"
        >
          <History className="size-3.5" />
          이전 이력 {hidden}개 더 보기
        </button>
      )}
      <ol className="space-y-3">
        {visible.map((item, i) => (
          <li key={`${item.kind}-${start + i}`} className="flex gap-3">
            <TimelineRail item={item} last={i === visible.length - 1} />
            <div className="min-w-0 flex-1">
              <EventItem workspace={workspace} item={item} />
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

function TimelineRail({ item, last }: { item: ActivityItem; last: boolean }) {
  const node = item.actor.known ? (
    <Avatar name={item.actor.name} url={item.actor.avatarUrl} size="sm" className="rounded-full" />
  ) : (
    <span className="grid size-6 place-items-center rounded-full bg-secondary text-faint ring-1 ring-inset ring-border">
      {item.kind === 'scorecard' ? <BarChart3 className="size-3" /> : <Sparkles className="size-3" />}
    </span>
  )
  return (
    <div className="flex flex-col items-center">
      {node}
      {!last && <span className="mt-1 w-px flex-1 bg-border" />}
    </div>
  )
}

function When({ at }: { at: string }) {
  return (
    <time className="shrink-0 text-[11px] text-faint" title={fmtDateTimeFull(at)}>
      {fmtTimeAgo(at)}
    </time>
  )
}

function EventItem({ workspace, item }: { workspace: string; item: ActivityItem }) {
  if (item.kind === 'created') {
    return (
      <div className="flex min-h-5 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12.5px] text-muted-foreground">
        <span className="font-[560] text-foreground">{item.actor.name}</span>
        님이 이 데이터셋을 만들었어요
        <When at={item.at} />
      </div>
    )
  }
  const tone = STATUS_TONE[item.status] ?? 'text-muted-foreground'
  return (
    <div className="flex min-h-5 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12.5px] text-muted-foreground">
      <span className="font-[560] text-foreground">{item.actor.name}</span>
      님이
      <Link
        href={`/${workspace}/harnesses/${encodeURIComponent(item.harnessId)}`}
        className="underline-offset-2 hover:text-foreground hover:underline"
      >
        <code className="font-mono text-foreground">{item.harness}</code>
      </Link>
      <Link
        href={`/${workspace}/scorecards/${encodeURIComponent(item.scorecardId)}`}
        className="font-[510] text-foreground underline-offset-2 hover:text-primary hover:underline"
      >
        스코어카드
      </Link>
      를 실행 ·
      <span className={cn('font-[560]', tone)}>{STATUS_LABEL[item.status] ?? item.status}</span>
      {item.passRate != null && (
        <span className="tabular-nums text-faint">통과율 {Math.round(item.passRate * 100)}%</span>
      )}
      <When at={item.at} />
    </div>
  )
}
