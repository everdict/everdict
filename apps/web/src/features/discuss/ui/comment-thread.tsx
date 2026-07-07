'use client'

import { useEffect, useRef, useState, useTransition, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { CornerDownRight, Loader2, MessageSquare, Trash2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import { fmtDateTimeFull, fmtTimeAgo } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Textarea } from '@/shared/ui/input'

import { createCommentAction, deleteCommentAction } from '../api/comments'
import type { Mentionable, ThreadComment } from '../model/types'

// 리소스 제네릭 댓글 스레드(1단계 대댓글, Linear 식) — 어느 상세 화면에서든 재사용.
export function CommentThread({
  workspace: _workspace,
  resourceType,
  resourceId,
  comments,
  mentionables,
  canComment,
}: {
  workspace: string
  resourceType: string
  resourceId: string
  comments: ThreadComment[]
  mentionables: Mentionable[]
  canComment: boolean
}) {
  const t = useTranslations('discuss')
  const tops = comments.filter((c) => !c.parentId)
  const repliesByParent = new Map<string, ThreadComment[]>()
  for (const c of comments) {
    if (c.parentId) {
      const arr = repliesByParent.get(c.parentId) ?? []
      arr.push(c)
      repliesByParent.set(c.parentId, arr)
    }
  }

  // 알림 #comment-<id> 진입 시 스크롤 + 하이라이트.
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
        />
      ))}
      {canComment ? (
        <div className="pt-1">
          <Composer
            resourceType={resourceType}
            resourceId={resourceId}
            mentionables={mentionables}
            placeholder={t('composerPlaceholder')}
          />
        </div>
      ) : (
        <p className="text-[12px] text-muted-foreground">{t('memberOnly')}</p>
      )}
    </div>
  )
}

// 최상위 댓글 + 대댓글들 + '답글' 인라인 작성기.
function CommentNode({
  comment,
  replies,
  mentionables,
  resourceType,
  resourceId,
  canComment,
}: {
  comment: ThreadComment
  replies: ThreadComment[]
  mentionables: Mentionable[]
  resourceType: string
  resourceId: string
  canComment: boolean
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

// 본문 내 @이름 하이라이트(긴 이름 우선).
function renderBody(body: string, mentionables: Mentionable[]): ReactNode {
  const names = [...new Set(mentionables.map((m) => m.name).filter(Boolean))].sort(
    (a, b) => b.length - a.length
  )
  if (names.length === 0) return body
  const re = new RegExp(
    `@(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
    'g'
  )
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

function CommentCard({ item, mentionables }: { item: ThreadComment; mentionables: Mentionable[] }) {
  const t = useTranslations('discuss')
  const locale = useLocale()
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
        {item.actor.known && (
          <Avatar
            name={item.actor.name}
            url={item.actor.avatarUrl}
            size="sm"
            className="rounded-full"
          />
        )}
        <span className="text-[12.5px] font-[560] text-foreground">{item.actor.name}</span>
        <time className="text-[11px] text-faint" title={fmtDateTimeFull(item.at)}>
          {fmtTimeAgo(item.at, locale)}
        </time>
        {item.canDelete && (
          <button
            type="button"
            onClick={onDelete}
            disabled={pending}
            aria-label={t('deleteComment')}
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

// @멘션 오토컴플리트 작성기 — 최상위/답글 공용. 제출 시 본문의 @이름 을 멤버로 해석해 mentions 전달.
function Composer({
  resourceType,
  resourceId,
  parentId,
  mentionables,
  placeholder,
  autoFocus,
  onDone,
}: {
  resourceType: string
  resourceId: string
  parentId?: string
  mentionables: Mentionable[]
  placeholder: string
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
      const r = await createCommentAction({
        resourceType,
        resourceId,
        body,
        ...(parentId ? { parentId } : {}),
        ...(mentions.length > 0 ? { mentions } : {}),
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
        <span className="text-[11px] text-faint">{t('mentionHint')}</span>
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
