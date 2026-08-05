'use client'

import { useState } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import type { IssueGroupBy, IssueSummary } from '@/entities/issue'
import { cn } from '@/shared/lib/utils'

import { loadIssuePageAction } from '../api/load-issues'
import type { IssueDirectories } from '../model/directories'
import type { IssuePageQuery } from '../model/page-query'
import { IssueGroupLabel } from './issue-group-label'
import { IssueRow } from './issue-row'

// 한 그룹 — 접을 수 있는 머리글(이름 + **진짜** 개수)과 그 아래 행들. 개수가 서버 집계에서 오는 것이
// 요점이다: 그룹마다 한 장씩 들고 있으므로 받은 행을 세면 페이지 크기를 되풀이할 뿐이고, "진행 중 3"이
// 실제로는 40 건인 화면은 헤더가 없느니만 못하다.
//
// 「더 보기」도 그룹마다 따로다(리니어와 같은 동선) — 이어 붙이는 것은 이 그룹의 행뿐이라, 다른 그룹을
// 펼쳐 둔 상태가 흐트러지지 않는다.
export function IssueGroup({
  workspace,
  groupBy,
  groupKey,
  count,
  initial,
  initialCursor,
  query,
  directories,
  canWrite,
  timeZone,
}: {
  workspace: string
  groupBy: IssueGroupBy
  groupKey: string | null
  count: number
  initial: IssueSummary[]
  initialCursor?: string
  // 이 그룹의 다음 장을 가져올 질의 — 서버가 첫 장에 쓴 것과 같은 것이다.
  query: IssuePageQuery
  directories: IssueDirectories
  canWrite: boolean
  timeZone: string
}) {
  const t = useTranslations('issuesPage')
  const [collapsed, setCollapsed] = useState(false)
  const [items, setItems] = useState(initial)
  const [cursor, setCursor] = useState(initialCursor)
  const [pending, setPending] = useState(false)

  // 서버가 새로 그린 첫 장이 진실이다 — 상태를 바꿔 `refresh()` 가 돌면 여기에 맞춘다. 더 불러온
  // 행은 그때 사라진다: 필터가 바뀐 뒤에도 남아 있으면 그 그룹에 속하지 않는 행이 계속 서 있게 된다.
  const [seen, setSeen] = useState(initial)
  if (seen !== initial) {
    setSeen(initial)
    setItems(initial)
    setCursor(initialCursor)
  }

  function loadMore() {
    if (cursor === undefined) return
    void (async () => {
      setPending(true)
      try {
        const r = await loadIssuePageAction({ ...query, cursor })
        if (!r.ok) {
          toast.error(r.error)
          return
        }
        setItems((prev) => [...prev, ...r.page.items])
        setCursor(r.page.nextCursor)
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <section className="space-y-1">
      <div className="flex items-center gap-1.5 px-1 py-1">
        <button
          type="button"
          onClick={() => setCollapsed((prev) => !prev)}
          aria-expanded={!collapsed}
          className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-[12.5px] font-[510] text-foreground transition-colors hover:bg-accent"
        >
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-faint transition-transform',
              !collapsed && 'rotate-90'
            )}
            aria-hidden
          />
          <IssueGroupLabel groupBy={groupBy} groupKey={groupKey} directories={directories} />
        </button>
        <span className="shrink-0 rounded-full bg-secondary px-1.5 text-[11px] tabular-nums text-muted-foreground">
          {count}
        </span>
      </div>
      {!collapsed && (
        <div className="space-y-1.5">
          {items.map((issue) => (
            <IssueRow
              key={issue.id}
              workspace={workspace}
              issue={issue}
              directories={directories}
              canWrite={canWrite}
              timeZone={timeZone}
            />
          ))}
          {cursor !== undefined && (
            <button
              type="button"
              onClick={loadMore}
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              {pending && <Loader2 className="size-3 animate-spin" />}
              {/* 남은 수를 말한다 — 개수를 아는 화면이 "더 보기"라고만 하는 건 아는 것을 숨기는 것이다. */}
              {t('groupLoadMore', { count: Math.max(count - items.length, 0) })}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
