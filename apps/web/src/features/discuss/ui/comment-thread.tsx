'use client'

import { memo, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  CornerDownRight,
  Loader2,
  MessageSquare,
  ShieldAlert,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { useLocale, useTimeZone, useTranslations } from 'next-intl'

import { MediaDropZone, withBlockInsertion } from '@/features/attach-media'
import { fmtDateTimeFull, fmtTimeAgo } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Textarea } from '@/shared/ui/input'
import { Markdown } from '@/shared/ui/markdown'

import { createCommentAction, deleteCommentAction, pollThreadAction } from '../api/comments'
import type { Mentionable, ThreadComment } from '../model/types'

// postMessage `type` that opens an agent comment's backing discussion session in the shell's agent chat — pairs
// with widgets/infra-panel (OPEN_AGENT_SESSION_MESSAGE; a feature cannot import the widget, keep in sync). Posted
// to the parent when this page renders inside the panel's iframe, else to our own window (same listener).
const OPEN_AGENT_SESSION = 'everdict:open-agent-session'

function openAgentSessionInShell(sessionId: string): void {
  if (typeof window === 'undefined') return
  const target = window.self !== window.top ? window.parent : window
  target.postMessage({ type: OPEN_AGENT_SESSION, sessionId }, window.location.origin)
}

// An agent turn is live while running or parked on approval — the thread polls itself until it settles.
function hasLiveAgentTurn(comments: ThreadComment[]): boolean {
  return comments.some(
    (c) => c.isAgent && (c.agentStatus === 'running' || c.agentStatus === 'awaiting_approval')
  )
}

// Resource-generic comment thread (one-level replies, Linear-style) — reusable on any detail screen.
export function CommentThread({
  workspace: _workspace,
  resourceType,
  resourceId,
  comments,
  mentionables,
  canComment,
  canAttach,
}: {
  workspace: string
  resourceType: string
  resourceId: string
  comments: ThreadComment[]
  mentionables: Mentionable[]
  canComment: boolean
  // 첨부는 워크스페이스 파일시스템에 쓰는 일이라 코멘트 권한과 별개의 판정이다(files:write).
  canAttach: boolean
}) {
  const t = useTranslations('discuss')
  // Server props seed the thread; while an agent answer is in flight the client polls the rebuilt thread so every
  // viewer sees the running → final transition live (the lifecycle is server-persisted on the comment row).
  const [thread, setThread] = useState<ThreadComment[]>(comments)
  useEffect(() => setThread(comments), [comments])
  const live = hasLiveAgentTurn(thread)
  useEffect(() => {
    if (!live) return
    let cancelled = false
    const interval = setInterval(() => {
      void (async () => {
        const r = await pollThreadAction({ resourceType, resourceId })
        if (!cancelled && r.ok && r.thread) setThread(r.thread)
      })()
    }, 2500)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [live, resourceType, resourceId])

  const tops = thread.filter((c) => !c.parentId)
  const repliesByParent = new Map<string, ThreadComment[]>()
  for (const c of thread) {
    if (c.parentId) {
      const arr = repliesByParent.get(c.parentId) ?? []
      arr.push(c)
      repliesByParent.set(c.parentId, arr)
    }
  }

  // On arriving from a notification at #comment-<id>, scroll + highlight.
  useEffect(() => {
    const hash = window.location.hash
    if (!hash.startsWith('#comment-')) return
    const el = document.getElementById(hash.slice(1))
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('ring-2', 'ring-primary/60')
    const t = setTimeout(() => el.classList.remove('ring-2', 'ring-primary/60'), 2400)
    return () => clearTimeout(t)
  }, [])

  return (
    <div className="space-y-3">
      {tops.length === 0 && (
        <p className="text-[12.5px] text-muted-foreground">
          {t('emptyTitle')}
          {canComment ? ` ${t('emptyPrompt')}` : ''}
        </p>
      )}
      {tops.map((c) => (
        <CommentNode
          key={c.id}
          comment={c}
          replies={repliesByParent.get(c.id) ?? []}
          mentionables={mentionables}
          resourceType={resourceType}
          resourceId={resourceId}
          canComment={canComment}
          canAttach={canAttach}
        />
      ))}
      {canComment ? (
        <div className="pt-1">
          <Composer
            resourceType={resourceType}
            resourceId={resourceId}
            mentionables={mentionables}
            placeholder={t('composerPlaceholder')}
            canAttach={canAttach}
          />
        </div>
      ) : (
        <p className="text-[12px] text-muted-foreground">{t('memberOnly')}</p>
      )}
    </div>
  )
}

// Top-level comment + its replies + a 'reply' inline composer.
function CommentNode({
  comment,
  replies,
  mentionables,
  resourceType,
  resourceId,
  canComment,
  canAttach,
}: {
  comment: ThreadComment
  replies: ThreadComment[]
  mentionables: Mentionable[]
  resourceType: string
  resourceId: string
  canComment: boolean
  canAttach: boolean
}) {
  const t = useTranslations('discuss')
  const [replying, setReplying] = useState(false)
  return (
    <div className="space-y-2">
      <CommentCard item={comment} mentionables={mentionables} />
      {(replies.length > 0 || replying) && (
        <div className="ml-5 space-y-2 border-l border-border/70 pl-4">
          {replies.map((r) => (
            <CommentCard key={r.id} item={r} mentionables={mentionables} />
          ))}
          {replying && (
            <Composer
              resourceType={resourceType}
              resourceId={resourceId}
              parentId={comment.id}
              mentionables={mentionables}
              placeholder={t('replyPlaceholder')}
              canAttach={canAttach}
              autoFocus
              onDone={() => setReplying(false)}
            />
          )}
        </div>
      )}
      {canComment && !replying && (
        <button
          type="button"
          onClick={() => setReplying(true)}
          className="ml-5 inline-flex items-center gap-1 text-[11.5px] font-[510] text-muted-foreground transition-colors hover:text-foreground"
        >
          <CornerDownRight className="size-3" /> {t('reply')}
        </button>
      )}
    </div>
  )
}

// The agent's live "doing now" line — the server stores a machine token; copy is localized here.
function activityLabel(
  t: (key: string, values?: Record<string, string>) => string,
  activity?: string
): string {
  if (activity === 'writing') return t('activityWriting')
  if (activity?.startsWith('tool:')) return t('activityTool', { name: activity.slice(5) })
  return t('activityThinking')
}

// 한 코멘트가 그리는 데 실제로 쓰는 것이 같은가. 폴링은 스레드를 통째로 다시 조립해 오므로(서버가 행에서 새로
// 만든다) 객체 정체성으로는 "안 바뀐 코멘트"를 알아볼 수 없다 — 그래서 필드로 비교한다.
function sameCard(
  a: { item: ThreadComment; mentionables: Mentionable[] },
  b: { item: ThreadComment; mentionables: Mentionable[] }
): boolean {
  if (a.mentionables !== b.mentionables) return false
  const x = a.item
  const y = b.item
  return (
    x.id === y.id &&
    x.body === y.body &&
    x.at === y.at &&
    x.canDelete === y.canDelete &&
    x.isAgent === y.isAgent &&
    x.agentStatus === y.agentStatus &&
    x.agentActivity === y.agentActivity &&
    x.agentSessionId === y.agentSessionId &&
    x.actor.name === y.actor.name &&
    x.actor.avatarUrl === y.actor.avatarUrl &&
    x.actor.known === y.actor.known
  )
}

// 한 코멘트. 에이전트가 답하는 동안 스레드는 2.5초마다 스스로 갱신되는데, 이 카드는 마크다운을 unified 파이프라인
// (remark-gfm → rehype-raw → sanitize) 전체로 다시 파싱한다 — 본문 하나에 약 5.6ms(node 기준, 브라우저 재조정
// 전)라 코멘트 20개면 갱신 한 번이 약 112ms 다. 그동안 화면은 멈춘다. 메모가 그 일을 건너뛰게 하는 유일한 방법이다
// (agent chat 이 같은 이유로 같은 처방을 받았다 — features/agent-chat/ui/transcript-render.test.tsx).
export const CommentCard = memo(function CommentCard({
  item,
  mentionables,
}: {
  item: ThreadComment
  mentionables: Mentionable[]
}) {
  const t = useTranslations('discuss')
  const locale = useLocale()
  const timeZone = useTimeZone()
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
        {item.isAgent ? (
          <span className="flex size-5 items-center justify-center rounded-full bg-primary/12 text-primary">
            <Sparkles className="size-3" />
          </span>
        ) : (
          item.actor.known && (
            <Avatar
              name={item.actor.name}
              url={item.actor.avatarUrl}
              size="sm"
              className="rounded-full"
            />
          )
        )}
        <span className="text-[12.5px] font-[560] text-foreground">{item.actor.name}</span>
        <time
          className="text-[11px] text-faint"
          title={fmtDateTimeFull(item.at, { locale, timeZone })}
        >
          {fmtTimeAgo(item.at, locale, timeZone)}
        </time>
        {item.isAgent && item.agentSessionId && (
          <button
            type="button"
            onClick={() => openAgentSessionInShell(item.agentSessionId as string)}
            className="ml-auto text-[11.5px] font-[510] text-muted-foreground transition-colors hover:text-primary"
          >
            {t('viewDetails')}
          </button>
        )}
        {item.canDelete && (
          <button
            type="button"
            onClick={onDelete}
            disabled={pending}
            aria-label={t('deleteComment')}
            className={cn(
              'text-faint transition-colors hover:text-destructive disabled:opacity-50',
              item.isAgent && item.agentSessionId ? '' : 'ml-auto'
            )}
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
          </button>
        )}
      </div>
      {item.isAgent ? (
        <AgentCommentBody item={item} mentionables={mentionables} />
      ) : (
        // A comment is written the way an issue body is — markdown. The viewer keeps single newlines, so a plain
        // note still reads as typed, and it highlights the @names the composer offered.
        <Markdown
          content={item.body}
          mentions={mentionables.map((m) => m.name)}
          className="text-[13px] leading-relaxed"
        />
      )}
      {error && (
        <Callout tone="danger" className="mt-2 py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}, sameCard)

// An agent answer renders compactly by lifecycle: a live "doing now" line while it works, an inline approval
// strip while parked, then ONLY the final markdown — the full reasoning/tool transcript lives behind "view
// details" (the right panel opens the backing discussion session).
function AgentCommentBody({
  item,
  mentionables,
}: {
  item: ThreadComment
  mentionables: Mentionable[]
}) {
  const t = useTranslations('discuss')
  if (item.agentStatus === 'complete')
    return (
      <Markdown
        content={item.body}
        mentions={mentionables.map((m) => m.name)}
        className="text-[13px] leading-relaxed"
      />
    )
  if (item.agentStatus === 'failed')
    return (
      <Callout tone="danger" className="py-1.5">
        {t('agentFailed')}
      </Callout>
    )
  if (item.agentStatus === 'awaiting_approval' && item.agentSessionId)
    return <ApprovalStrip sessionId={item.agentSessionId} />
  if (item.agentStatus === 'awaiting_approval')
    return (
      <span className="inline-flex items-center gap-1.5 text-[12.5px] font-[510] text-amber-600 dark:text-amber-400">
        <ShieldAlert className="size-3.5" />
        {t('awaitingApproval', { name: item.agentActivity?.replace(/^tool:/, '') ?? '' })}
      </span>
    )
  // running (or a not-yet-reported placeholder)
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      {activityLabel(t, item.agentActivity)}
    </span>
  )
}

// Inline HITL: the parked write-tool asks, decidable RIGHT IN the comment (any member — the discussion session
// is workspace-visible and the permission route accepts it). Polls the session's /pending while parked; a
// decision posts to the normal /permission route and the thread's own polling reflects the resumed turn.
function ApprovalStrip({ sessionId }: { sessionId: string }) {
  const t = useTranslations('discuss')
  const [asks, setAsks] = useState<{ requestId: string; name: string }[]>([])
  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/pending`, {
          cache: 'no-store',
        })
        if (!res.ok) return
        const data = (await res.json()) as {
          pending?: { requestId?: unknown; name?: unknown }[]
        }
        if (!cancelled && Array.isArray(data.pending))
          setAsks(
            data.pending
              .filter(
                (p): p is { requestId: string; name: string } =>
                  typeof p.requestId === 'string' && typeof p.name === 'string'
              )
              .map((p) => ({ requestId: p.requestId, name: p.name }))
          )
      } catch {
        // silent — retried on the next tick
      }
    }
    void tick()
    const interval = setInterval(() => void tick(), 2500)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [sessionId])
  function decide(requestId: string, decision: 'allow' | 'deny') {
    setAsks((prev) => prev.filter((a) => a.requestId !== requestId))
    // Fire-and-forget: a failure falls back to the server-side deny-on-timeout, so the UI never blocks on it.
    void fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, decision }),
    }).catch(() => undefined)
  }
  if (asks.length === 0)
    return (
      <span className="inline-flex items-center gap-1.5 text-[12.5px] font-[510] text-amber-600 dark:text-amber-400">
        <ShieldAlert className="size-3.5" />
        {t('awaitingApproval', { name: '…' })}
      </span>
    )
  return (
    <div className="space-y-1.5">
      {asks.map((ask) => (
        <div key={ask.requestId} className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-[12.5px] font-[510] text-amber-600 dark:text-amber-400">
            <ShieldAlert className="size-3.5" />
            {t('awaitingApproval', { name: ask.name })}
          </span>
          <Button
            size="sm"
            className="h-6 px-2 text-[11.5px]"
            onClick={() => decide(ask.requestId, 'allow')}
          >
            {t('approve')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11.5px]"
            onClick={() => decide(ask.requestId, 'deny')}
          >
            {t('deny')}
          </Button>
        </div>
      ))}
    </div>
  )
}

// @mention autocomplete composer — shared by top-level/reply. On submit, resolve @names in the body to members and pass mentions.
function Composer({
  resourceType,
  resourceId,
  parentId,
  mentionables,
  placeholder,
  canAttach,
  autoFocus,
  onDone,
}: {
  resourceType: string
  resourceId: string
  parentId?: string
  mentionables: Mentionable[]
  placeholder: string
  canAttach: boolean
  autoFocus?: boolean
  onDone?: () => void
}) {
  const t = useTranslations('discuss')
  const router = useRouter()
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [value, setValue] = useState('')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const [menu, setMenu] = useState<{ query: string; at: number } | undefined>(undefined)
  const [active, setActive] = useState(0)

  useEffect(() => {
    if (autoFocus) taRef.current?.focus()
  }, [autoFocus])

  function refreshMenu(text: string, caret: number) {
    const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret))
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
    queueMicrotask(() => {
      const pos = `${before}@${mn.name} `.length
      taRef.current?.focus()
      taRef.current?.setSelectionRange(pos, pos)
    })
  }
  // 올라간 첨부는 커서 자리에 들어간다. 현재 값은 상태가 아니라 텍스트영역에서 읽는다 — 파일 여러 개를 놓으면
  // 업로드가 하나씩 이어지는데, 그 사이 렌더에서 닫힌 상태 값은 이미 지난 값이기 때문이다.
  function insertSnippet(snippet: string) {
    const ta = taRef.current
    const current = ta?.value ?? value
    const start = ta?.selectionStart ?? current.length
    const end = ta?.selectionEnd ?? current.length
    const next = withBlockInsertion(current, start, end, snippet)
    setValue(next.value)
    setMenu(undefined)
    queueMicrotask(() => {
      taRef.current?.focus()
      taRef.current?.setSelectionRange(next.caret, next.caret)
    })
  }

  function mentioned(text: string, name: string): boolean {
    return new RegExp(`(^|\\s)@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$|[.,!?])`).test(
      text
    )
  }
  // Member mentions only — the synthetic @everdict entry is never a notification target; it flips askAgent instead.
  function extractMentions(text: string): string[] {
    return mentionables
      .filter((mn) => !mn.isAgent && mentioned(text, mn.name))
      .map((mn) => mn.subject)
  }
  function onSubmit() {
    const body = value.trim()
    if (!body) return
    setError(undefined)
    const mentions = extractMentions(body)
    // @everdict mentioned → hand the thread to the discussion agent (its answer lands as an agent comment).
    const askAgent = mentionables.some((mn) => mn.isAgent && mentioned(body, mn.name))
    startTransition(async () => {
      const r = await createCommentAction({
        resourceType,
        resourceId,
        body,
        ...(parentId ? { parentId } : {}),
        ...(mentions.length > 0 ? { mentions } : {}),
        ...(askAgent ? { askAgent: true } : {}),
      })
      if (r.ok) {
        setValue('')
        setMenu(undefined)
        onDone?.()
        router.refresh()
      } else setError(r.error)
    })
  }

  return (
    <div className="space-y-2 rounded-lg border bg-card/40 p-3">
      {/* 스크린샷은 논의의 절반이다 — 붙여넣거나 끌어다 놓으면 그 자리에서 첨부되고 본문에 문법이 들어간다. */}
      <MediaDropZone onInsert={insertSnippet} disabled={!canAttach}>
        <div className="relative">
          <Textarea
            ref={taRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              refreshMenu(e.target.value, e.target.selectionStart ?? e.target.value.length)
            }}
            onClick={(e) => refreshMenu(value, e.currentTarget.selectionStart ?? 0)}
            placeholder={placeholder}
            className="min-h-14 text-[13px]"
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
                  {mn.isAgent ? (
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary/12 text-primary">
                      <Sparkles className="size-3" />
                    </span>
                  ) : (
                    <Avatar name={mn.name} url={mn.avatarUrl} size="sm" className="rounded-full" />
                  )}
                  <span className="truncate">{mn.name}</span>
                  {mn.isAgent && (
                    <span className="ml-auto text-[11px] text-faint">{t('askAgentHint')}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </MediaDropZone>
      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-faint">
          {canAttach ? `${t('mentionHint')} · ${t('attachHint')}` : t('mentionHint')}
        </span>
        <div className="flex items-center gap-2">
          {onDone && (
            <button
              type="button"
              onClick={onDone}
              className="text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {t('cancel')}
            </button>
          )}
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
            {parentId ? t('reply') : t('submit')}
          </Button>
        </div>
      </div>
    </div>
  )
}
