'use client'

import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { BarChart3, History, Loader2, MessageSquare, Sparkles, Trash2 } from 'lucide-react'

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
      harnessId: string // 하니스 상세 링크용(버전 제외 id)
      harness: string // 표시용 id@version
      status: string
      passRate: number | null
    }
  | { kind: 'comment'; at: string; actor: Actor; id: string; body: string; canDelete: boolean }

// @멘션 후보(워크스페이스 멤버) — 작성기 오토컴플리트 + 본문 내 @이름 하이라이트에 사용.
export interface Mentionable {
  subject: string
  name: string
  avatarUrl?: string
}

const INITIAL = 10 // 최근 N개만 기본 노출(댓글 리스트처럼) — 나머지는 '이전 이력 보기'로.
const STEP = 20 // '이전 이력 보기' 한 번에 더 여는 개수.

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
  mentionables,
}: {
  workspace: string
  datasetId: string
  items: ActivityItem[]
  canComment: boolean
  mentionables: Mentionable[]
}) {
  // 최근 INITIAL 개만 기본 노출(items 는 오래된→최신이라 뒤에서 잘라 보인다). '이전 이력 보기'로 더.
  const [shown, setShown] = useState(INITIAL)
  const start = Math.max(0, items.length - shown)
  const visible = items.slice(start)
  const hidden = start

  // 알림에서 #comment-<id> 로 진입 시: 접힘으로 대상이 없으면 전부 펼친 뒤, 해당 댓글로 스크롤 + 잠깐 하이라이트.
  useEffect(() => {
    const hash = window.location.hash
    if (!hash.startsWith('#comment-')) return
    if (!document.getElementById(hash.slice(1))) {
      setShown(items.length) // 오래된 댓글이면 먼저 전부 펼친다.
      return
    }
    const el = document.getElementById(hash.slice(1))
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('ring-2', 'ring-primary/60')
    const t = setTimeout(() => el.classList.remove('ring-2', 'ring-primary/60'), 2400)
    return () => clearTimeout(t)
    // shown 이 바뀌면(펼침) 다시 시도해 스크롤한다.
  }, [items.length, shown])

  return (
    <div className="space-y-4">
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
          <li
            key={item.kind === 'comment' ? `c-${item.id}` : `${item.kind}-${start + i}`}
            className="flex gap-3"
          >
            <TimelineRail item={item} last={i === visible.length - 1} />
            <div className="min-w-0 flex-1 pb-1">
              {item.kind === 'comment' ? (
                <CommentItem item={item} mentionables={mentionables} />
              ) : (
                <EventItem workspace={workspace} item={item} />
              )}
            </div>
          </li>
        ))}
      </ol>
      {canComment ? (
        <Composer datasetId={datasetId} mentionables={mentionables} />
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
      // 유저 프로필은 둥근 이미지로 통일(모노그램/업로드 모두 rounded-full).
      <Avatar
        name={item.actor.name}
        url={item.actor.avatarUrl}
        size="sm"
        className="rounded-full"
      />
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
  // 댓글은 카드(상단 패딩 py-2.5)라 아바타를 그 패딩만큼 내려 작성자 이름 줄과 세로 중앙을 맞춘다.
  return (
    <div className={cn('flex flex-col items-center', item.kind === 'comment' && 'pt-2')}>
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
      {/* 하니스 이름 → 하니스 상세, '스코어카드' → 이 실행(스코어카드) 상세. 각 텍스트에 해당 링크. */}
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

// 본문 내 @이름 을 멤버와 매칭해 하이라이트(긴 이름 우선). 매칭 안 되면 그냥 텍스트.
function renderBody(body: string, mentionables: Mentionable[]): ReactNode {
  const names = mentionables.map((m) => m.name).filter(Boolean)
  if (names.length === 0) return body
  const sorted = [...new Set(names)].sort((a, b) => b.length - a.length)
  const escaped = sorted.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`@(${escaped.join('|')})`, 'g')
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  // biome-ignore lint/suspicious/noAssignInExpressions: 정규식 순회 표준 패턴
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) out.push(body.slice(last, m.index))
    out.push(
      <span key={k++} className="rounded bg-primary/12 px-1 font-[560] text-primary">
        {m[0]}
      </span>
    )
    last = m.index + m[0].length
  }
  if (last < body.length) out.push(body.slice(last))
  return out
}

// 댓글 — 카드(작성자 + 시각 + 본문 + 삭제). id=comment-<id> 앵커(알림에서 스크롤 진입).
function CommentItem({
  item,
  mentionables,
}: {
  item: Extract<ActivityItem, { kind: 'comment' }>
  mentionables: Mentionable[]
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
    <div
      id={`comment-${item.id}`}
      className="scroll-mt-20 rounded-lg border bg-card px-3.5 py-2.5 shadow-raise transition-shadow"
    >
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
        {renderBody(item.body, mentionables)}
      </p>
      {error && (
        <Callout tone="danger" className="mt-2 py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}

// 댓글 작성기 — 하단 고정. @ 입력 시 멤버 오토컴플리트, 제출 시 본문의 @이름 을 subject 로 해석해 mentions 전달.
function Composer({ datasetId, mentionables }: { datasetId: string; mentionables: Mentionable[] }) {
  const router = useRouter()
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [value, setValue] = useState('')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  // @멘션 오토컴플리트 상태 — 커서 앞 '@쿼리' 를 잡아 후보를 띄운다.
  const [menu, setMenu] = useState<{ query: string; at: number } | undefined>(undefined)
  const [active, setActive] = useState(0)

  // 커서 앞 텍스트에서 마지막 '@단어' 를 찾는다(공백 없이 이어지는 토큰). 없으면 메뉴 닫음.
  function refreshMenu(text: string, caret: number) {
    const upto = text.slice(0, caret)
    const m = /(^|\s)@([^\s@]*)$/.exec(upto)
    if (!m) {
      setMenu(undefined)
      return
    }
    setMenu({ query: m[2] ?? '', at: caret - (m[2] ?? '').length - 1 })
    setActive(0)
  }

  const matches = menu
    ? mentionables
        .filter((mn) => mn.name.toLowerCase().includes(menu.query.toLowerCase()))
        .slice(0, 6)
    : []

  function pick(mn: Mentionable) {
    if (!menu) return
    const before = value.slice(0, menu.at)
    const after = value.slice(menu.at + 1 + menu.query.length)
    const next = `${before}@${mn.name} ${after}`
    setValue(next)
    setMenu(undefined)
    // 삽입 후 커서를 이름 뒤로.
    queueMicrotask(() => {
      const pos = (before + '@' + mn.name + ' ').length
      taRef.current?.focus()
      taRef.current?.setSelectionRange(pos, pos)
    })
  }

  // 제출 시 본문에서 실제로 남아있는 @이름 을 멤버로 해석 → subject 목록.
  function extractMentions(text: string): string[] {
    return mentionables
      .filter((mn) =>
        new RegExp(`(^|\\s)@${mn.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$|[.,!?])`).test(
          text
        )
      )
      .map((mn) => mn.subject)
  }

  function onSubmit() {
    const body = value.trim()
    if (!body) return
    setError(undefined)
    const mentions = extractMentions(body)
    startTransition(async () => {
      const r = await createCommentAction(datasetId, body, mentions)
      if (r.ok) {
        setValue('')
        setMenu(undefined)
        router.refresh()
      } else setError(r.error)
    })
  }

  return (
    <div className="space-y-2 rounded-lg border bg-card/40 p-3">
      <div className="relative">
        <Textarea
          ref={taRef}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            refreshMenu(e.target.value, e.target.selectionStart ?? e.target.value.length)
          }}
          onClick={(e) => refreshMenu(value, e.currentTarget.selectionStart ?? 0)}
          placeholder="이 데이터셋에 대한 논의를 남겨요… @로 멤버를 언급하면 알림이 가요"
          className="min-h-16 text-[13px]"
          onKeyDown={(e) => {
            if (menu && matches.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setActive((a) => (a + 1) % matches.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setActive((a) => (a - 1 + matches.length) % matches.length)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                const sel = matches[active]
                if (sel) {
                  e.preventDefault()
                  pick(sel)
                  return
                }
              }
              if (e.key === 'Escape') {
                setMenu(undefined)
                return
              }
            }
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onSubmit()
          }}
        />
        {menu && matches.length > 0 && (
          <div className="absolute left-2 top-full z-20 mt-1 w-64 overflow-hidden rounded-lg border bg-popover shadow-pop">
            {matches.map((mn, i) => (
              <button
                key={mn.subject}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(mn)
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] transition-colors',
                  i === active ? 'bg-accent text-foreground' : 'hover:bg-accent/60'
                )}
              >
                <Avatar name={mn.name} url={mn.avatarUrl} size="sm" className="rounded-full" />
                <span className="truncate">{mn.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-faint">@ 멘션 · ⌘/Ctrl + Enter 로 등록</span>
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
