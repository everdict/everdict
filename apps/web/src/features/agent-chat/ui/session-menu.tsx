'use client'

import { useState } from 'react'
import { Check, History, MessageSquare, Pencil, Trash2, X } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import type { AgentSession } from '@/entities/agent-session'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { DropdownLabel, DropdownMenu, useDropdownClose } from '@/shared/ui/dropdown-menu'

// 대화창 헤더의 히스토리 버튼 → 플로팅 드롭다운으로 지난 대화를 보여준다. 페이지 전환 없이(대화창을 떠나지 않고)
// 세션 열기·이름변경·삭제를 전부 메뉴 안에서 처리한다. 삭제 확인은 다이얼로그 대신 행 인라인 2단계로 —
// 포털된 다이얼로그 클릭이 드롭다운의 outside-click 으로 잡혀 메뉴가 닫히는 문제를 피한다.

type Bucket = 'today' | 'yesterday' | 'earlier'

function bucketOf(iso: string): Bucket {
  const t = new Date(iso).getTime()
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (t >= startToday) return 'today'
  if (t >= startToday - 86_400_000) return 'yesterday'
  return 'earlier'
}

function relativeTime(iso: string, locale: string): string {
  const diff = new Date(iso).getTime() - Date.now()
  const abs = Math.abs(diff)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (abs < minute) return rtf.format(0, 'minute')
  if (abs < hour) return rtf.format(Math.round(diff / minute), 'minute')
  if (abs < day) return rtf.format(Math.round(diff / hour), 'hour')
  if (abs < 7 * day) return rtf.format(Math.round(diff / day), 'day')
  return new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

const BUCKET_ORDER: Bucket[] = ['today', 'yesterday', 'earlier']

function SessionRows({
  sessions,
  activeId,
  onOpen,
  onDelete,
  onRename,
}: {
  sessions: AgentSession[]
  activeId: string | null
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
}) {
  const t = useTranslations('agentChat')
  const locale = useLocale()
  const close = useDropdownClose()
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  const startRename = (s: AgentSession) => {
    setPendingDelete(null)
    setRenaming(s.id)
    setDraft(s.title)
  }
  const commitRename = (id: string) => {
    if (renaming !== id) return
    setRenaming(null)
    if (draft.trim().length > 0) onRename(id, draft.trim())
  }

  const grouped = new Map<Bucket, AgentSession[]>()
  for (const s of sessions) {
    const b = bucketOf(s.updatedAt)
    const list = grouped.get(b) ?? []
    list.push(s)
    grouped.set(b, list)
  }

  return (
    <>
      {BUCKET_ORDER.filter((b) => grouped.has(b)).map((b) => (
        <div key={b} className="mb-0.5">
          <div className="px-2 pb-0.5 pt-1.5 text-[10.5px] font-[510] uppercase tracking-wide text-faint">
            {t(`bucket.${b}`)}
          </div>
          <ul className="space-y-0.5">
            {grouped.get(b)?.map((s) => (
              <li
                key={s.id}
                className={cn(
                  'group flex items-center gap-1 rounded-md pr-1 transition-colors hover:bg-accent',
                  s.id === activeId && 'bg-accent'
                )}
              >
                {renaming === s.id ? (
                  <input
                    // biome-ignore lint/a11y/noAutofocus: focus the rename field the moment it appears
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitRename(s.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(s.id)
                      else if (e.key === 'Escape') {
                        // 드롭다운의 문서 레벨 Esc(메뉴 닫기)까지 번지지 않게 — 이름변경만 취소한다.
                        e.stopPropagation()
                        setRenaming(null)
                      }
                    }}
                    className="m-1 min-w-0 flex-1 rounded border border-primary/50 bg-background px-2 py-1 text-[13px] outline-none"
                  />
                ) : pendingDelete === s.id ? (
                  <>
                    <span className="min-w-0 flex-1 truncate px-2 py-1.5 text-[13px] text-destructive">
                      {s.title}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('delete')}
                      onClick={() => {
                        setPendingDelete(null)
                        onDelete(s.id)
                      }}
                      className="size-6 text-destructive hover:text-destructive"
                    >
                      <Check className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('cancel')}
                      onClick={() => setPendingDelete(null)}
                      className="size-6"
                    >
                      <X className="size-3.5" />
                    </Button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        onOpen(s.id)
                        close()
                      }}
                      onDoubleClick={() => startRename(s)}
                      className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
                    >
                      <MessageSquare
                        className="size-4 shrink-0 text-muted-foreground/60"
                        strokeWidth={1.75}
                      />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                        {s.title}
                      </span>
                      <span className="shrink-0 text-[10.5px] tabular-nums text-faint group-hover:hidden">
                        {relativeTime(s.updatedAt, locale)}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('rename')}
                      onClick={() => startRename(s)}
                      className="size-6 opacity-0 group-hover:opacity-100"
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('delete')}
                      onClick={() => setPendingDelete(s.id)}
                      className="size-6 opacity-0 hover:text-destructive group-hover:opacity-100"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  )
}

export function SessionMenu({
  sessions,
  activeId,
  onOpen,
  onDelete,
  onRename,
}: {
  sessions: AgentSession[]
  activeId: string | null
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
}) {
  const t = useTranslations('agentChat')
  return (
    <DropdownMenu
      align="end"
      contentClassName="w-72"
      trigger={({ toggle, open }) => (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('history')}
          aria-expanded={open}
          onClick={toggle}
        >
          <History />
        </Button>
      )}
    >
      <DropdownLabel>{t('history')}</DropdownLabel>
      <div className="max-h-[min(360px,50vh)] overflow-y-auto">
        {sessions.length === 0 ? (
          <p className="px-2 pb-2 pt-0.5 text-[12px] leading-relaxed text-muted-foreground">
            {t('empty')}
          </p>
        ) : (
          <SessionRows
            sessions={sessions}
            activeId={activeId}
            onOpen={onOpen}
            onDelete={onDelete}
            onRename={onRename}
          />
        )}
      </div>
    </DropdownMenu>
  )
}
