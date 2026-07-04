'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { BarChart3, Loader2, MessageSquare, Sparkles, Trash2 } from 'lucide-react'

import { fmtDateTimeFull, fmtTimeAgo } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Textarea } from '@/shared/ui/input'

import { createCommentAction, deleteCommentAction } from '../api/comments'

// 활동 항목(서버가 표시-준비 상태로 조립: actor 이름/아바타 해석 완료) — 이벤트 + 댓글이 한 스트림에 섞인다.
export interface Actor {
  name: string
  avatarUrl?: string
  known: boolean
}
export type ActivityItem =
  | { kind: 'created'; at: string; actor: Actor }
  | {
      kind: 'scorecard'
      at: string
      actor: Actor
      scorecardId: string
      harness: string
      status: string
      passRate: number | null
    }
  | { kind: 'comment'; at: string; actor: Actor; id: string; body: string; canDelete: boolean }

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

// 데이터셋 활동 히스토리 + 댓글 — Linear 이슈처럼 "누가 언제 무엇을" 시간순(오래된→최신)으로, 하단에 작성기.
export function ActivityTimeline({
  workspace,
  datasetId,
  items,
  canComment,
}: {
  workspace: string
  datasetId: string
  items: ActivityItem[]
  canComment: boolean
}) {
  return (
    <div className="space-y-4">
      <ol className="space-y-3">
        {items.map((item, i) => (
          <li
            key={item.kind === 'comment' ? `c-${item.id}` : `${item.kind}-${i}`}
            className="flex gap-3"
          >
            <TimelineRail item={item} last={i === items.length - 1} />
            <div className="min-w-0 flex-1 pb-1">
              {item.kind === 'comment' ? (
                <CommentItem workspace={workspace} item={item} />
              ) : (
                <EventItem workspace={workspace} item={item} />
              )}
            </div>
          </li>
        ))}
      </ol>
      {canComment ? (
        <Composer datasetId={datasetId} />
      ) : (
        <p className="text-[12px] text-muted-foreground">댓글을 남기려면 멤버 권한이 필요해요.</p>
      )}
    </div>
  )
}

// 좌측 레일 — 아바타(사람 있으면) 또는 종류 아이콘 점 + 세로 연결선.
function TimelineRail({ item, last }: { item: ActivityItem; last: boolean }) {
  const node =
    item.actor.known &&
    (item.kind === 'comment' || item.kind === 'scorecard' || item.kind === 'created') ? (
      <Avatar name={item.actor.name} url={item.actor.avatarUrl} size="sm" />
    ) : (
      <span className="grid size-6 place-items-center rounded-full bg-secondary text-faint ring-1 ring-inset ring-border">
        {item.kind === 'comment' ? (
          <MessageSquare className="size-3" />
        ) : item.kind === 'scorecard' ? (
          <BarChart3 className="size-3" />
        ) : (
          <Sparkles className="size-3" />
        )}
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

// 이벤트(생성 / 스코어카드 실행) — 컴팩트 한 줄.
function EventItem({
  workspace,
  item,
}: {
  workspace: string
  item: Extract<ActivityItem, { kind: 'created' | 'scorecard' }>
}) {
  if (item.kind === 'created') {
    return (
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 pt-1 text-[12.5px] text-muted-foreground">
        <span className="font-[560] text-foreground">{item.actor.name}</span>
        님이 이 데이터셋을 만들었어요
        <When at={item.at} />
      </div>
    )
  }
  const tone = STATUS_TONE[item.status] ?? 'text-muted-foreground'
  return (
    <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 pt-1 text-[12.5px] text-muted-foreground">
      <span className="font-[560] text-foreground">{item.actor.name}</span>
      님이
      <Link
        href={`/${workspace}/scorecards/${encodeURIComponent(item.scorecardId)}`}
        className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
      >
        <code className="font-mono text-foreground">{item.harness}</code>
      </Link>
      스코어카드를 실행 ·
      <span className={cn('font-[560]', tone)}>{STATUS_LABEL[item.status] ?? item.status}</span>
      {item.passRate != null && (
        <span className="tabular-nums text-faint">통과율 {Math.round(item.passRate * 100)}%</span>
      )}
      <When at={item.at} />
    </div>
  )
}

// 댓글 — 카드(작성자 + 시각 + 본문 + 삭제).
function CommentItem({
  workspace: _workspace,
  item,
}: {
  workspace: string
  item: Extract<ActivityItem, { kind: 'comment' }>
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  function onDelete() {
    setError(undefined)
    startTransition(async () => {
      const r = await deleteCommentAction(item.id)
      if (r.ok) router.refresh()
      else setError(r.error)
    })
  }
  return (
    <div className="rounded-lg border bg-card px-3.5 py-2.5 shadow-raise">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[12.5px] font-[560] text-foreground">{item.actor.name}</span>
        <When at={item.at} />
        {item.canDelete && (
          <button
            type="button"
            onClick={onDelete}
            disabled={pending}
            aria-label="댓글 삭제"
            className="ml-auto text-faint transition-colors hover:text-destructive disabled:opacity-50"
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
          </button>
        )}
      </div>
      <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground">
        {item.body}
      </p>
      {error && (
        <Callout tone="danger" className="mt-2 py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}

// 댓글 작성기 — 하단 고정. 제출 후 refresh 로 타임라인 갱신.
function Composer({ datasetId }: { datasetId: string }) {
  const router = useRouter()
  const [value, setValue] = useState('')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  function onSubmit() {
    const body = value.trim()
    if (!body) return
    setError(undefined)
    startTransition(async () => {
      const r = await createCommentAction(datasetId, body)
      if (r.ok) {
        setValue('')
        router.refresh()
      } else setError(r.error)
    })
  }
  return (
    <div className="space-y-2 rounded-lg border bg-card/40 p-3">
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="이 데이터셋에 대한 논의를 남겨요… (누가 언제 무엇을 했는지 맥락을 이어가요)"
        className="min-h-16 text-[13px]"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onSubmit()
        }}
      />
      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-faint">⌘/Ctrl + Enter 로 등록</span>
        <Button
          type="button"
          size="sm"
          className="gap-1.5"
          disabled={pending || value.trim().length === 0}
          onClick={onSubmit}
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <MessageSquare className="size-3.5" />
          )}
          댓글 남기기
        </Button>
      </div>
    </div>
  )
}
