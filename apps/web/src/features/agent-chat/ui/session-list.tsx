'use client'

import { useState } from 'react'
import { MessageSquare, MessageSquarePlus, Pencil, Sparkles, Trash2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import type { AgentSession } from '@/entities/agent-session'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Dialog } from '@/shared/ui/dialog'
import { EmptyState } from '@/shared/ui/empty-state'

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

export function SessionList({
  sessions,
  activeId,
  onOpen,
  onNew,
  onDelete,
  onRename,
}: {
  sessions: AgentSession[]
  activeId: string | null
  onOpen: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
}) {
  const t = useTranslations('agentChat')
  const locale = useLocale()
  const [pendingDelete, setPendingDelete] = useState<AgentSession | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const startRename = (s: AgentSession) => {
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
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="text-[12px] font-[510] text-muted-foreground">{t('subtitle')}</span>
        <Button size="xs" onClick={onNew}>
          <MessageSquarePlus />
          {t('new')}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {sessions.length === 0 ? (
          <div className="px-1 pt-6">
            <EmptyState
              icon={<Sparkles strokeWidth={1.5} />}
              title={t('emptyTitle')}
              hint={t('empty')}
              action={
                <Button size="sm" onClick={onNew}>
                  <MessageSquarePlus />
                  {t('startChat')}
                </Button>
              }
            />
          </div>
        ) : (
          BUCKET_ORDER.filter((b) => grouped.has(b)).map((b) => (
            <div key={b} className="mb-1">
              <div className="px-2 pb-0.5 pt-2 text-[10.5px] font-[510] uppercase tracking-wide text-faint">
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
                          else if (e.key === 'Escape') setRenaming(null)
                        }}
                        className="m-1 min-w-0 flex-1 rounded border border-primary/50 bg-background px-2 py-1 text-[13px] outline-none"
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => onOpen(s.id)}
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
                          onClick={() => setPendingDelete(s)}
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
          ))
        )}
      </div>

      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        className="max-w-sm"
      >
        <div className="space-y-3 p-4">
          <h3 className="text-[14px] font-[560] text-foreground">{t('confirmDelete')}</h3>
          <p className="truncate text-[12.5px] text-muted-foreground">{pendingDelete?.title}</p>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => setPendingDelete(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                if (pendingDelete) onDelete(pendingDelete.id)
                setPendingDelete(null)
              }}
            >
              {t('delete')}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
