'use client'

import { useCallback, useRef, useState, type ReactNode } from 'react'
import { CircleDot } from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  ISSUE_FILTER_FACETS,
  issueViewHref,
  normalizeIssueDisplay,
  saveIssueDisplay,
  toggleIssueFilter,
  type IssueSummary,
  type IssueView,
} from '@/entities/issue'
import { cn } from '@/shared/lib/utils'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'

import type { IssueViewBase, IssueViewData } from '../api/issue-view-data'
import { loadIssueViewAction } from '../api/load-issue-view'
import { loadIssuePageAction } from '../api/load-issues'
import type { IssueDirectories } from '../model/directories'
import { IssueBoard, type IssueBoardColumn } from './issue-board'
import { IssueDisplayMenu } from './issue-display-menu'
import { IssueFilterMenu } from './issue-filter-menu'
import { IssueGroup } from './issue-group'
import { IssueRow } from './issue-row'

// 이슈 목록의 본문 — 툴바와 행들. 보기(필터·표시)를 **여기가** 들고 있는 것이 이 화면의 핵심이다.
//
// 예전에는 필터를 켜면 `router.push`, 묶는 기준을 바꾸면 서버 액션 + `router.refresh()` 였다. 둘 다 라우트를
// 통째로 다시 그리는 일이라 화면이 스켈레톤으로 비워졌고, 목록과 아무 상관 없는 읽기(멤버·프로젝트·라벨·
// 사이클 로스터, GitHub App 상태)까지 매번 다시 돌았다. 이제 바뀌는 것은 목록뿐이고, 새 목록이 도착할
// 때까지 **이전 목록이 화면에 그대로 서 있는다** — 리니어가 그렇듯이.
//
// 주소는 뒤따라온다: 필터만 `history.replaceState` 로 적는다(서버 렌더를 일으키지 않는 문). 그래서 붙여넣을
// 수 있는 링크라는 성질은 그대로고, 표시 설정은 여전히 주소에 실리지 않는다 — 보낸 링크가 받는 사람의 화면
// 배치를 바꾸면 안 된다.
export function IssueListBody({
  workspace,
  basePath,
  viewKey,
  base,
  initialView,
  initialData,
  directories,
  projects,
  cycles,
  canWrite,
  timeZone,
  chips,
  footer,
}: {
  workspace: string
  basePath: string
  viewKey: string
  // 주소가 정한 좁히기(팀·트리아지·사이클) — 보기를 바꿔도 변하지 않는다.
  base: IssueViewBase
  initialView: IssueView
  initialData: IssueViewData
  directories: IssueDirectories
  projects: { id: string; name: string }[]
  cycles: { id: string; name: string }[]
  canWrite: boolean
  timeZone: string
  // 워크스페이스 전체 목록의 팀 칩 — 서버가 그려 넘긴다(보기와 무관하고, 링크일 뿐이다).
  chips?: ReactNode
  // 일괄 편집 바 — 고를 대상이 있는 화면에서만.
  footer?: ReactNode
}) {
  const t = useTranslations('issuesPage')
  const [view, setView] = useState(initialView)
  const [data, setData] = useState(initialData)
  const [pending, setPending] = useState(false)
  // 늦게 도착한 응답이 최신 화면을 덮어쓰지 않게 — 빠르게 두 번 만지면 순서가 뒤집힐 수 있다.
  const sequence = useRef(0)

  const apply = useCallback(
    (next: IssueView) => {
      const merged: IssueView = { ...normalizeIssueDisplay(next), filters: next.filters }
      setView(merged)
      // 필터만 주소에, 표시 설정만 쿠키에. 둘 다 서버 왕복이 없다.
      window.history.replaceState(null, '', issueViewHref(basePath, merged))
      saveIssueDisplay(viewKey, merged)
      const seq = sequence.current + 1
      sequence.current = seq
      setPending(true)
      void loadIssueViewAction({ base, view: merged })
        .then((fresh) => {
          if (sequence.current !== seq) return
          setData(fresh)
          setPending(false)
        })
        .catch((e: unknown) => {
          if (sequence.current !== seq) return
          setData({
            groups: [],
            droppedGroups: 0,
            error: { kind: 'load', message: e instanceof Error ? e.message : String(e) },
          })
          setPending(false)
        })
    },
    [base, basePath, viewKey]
  )

  const error =
    data.error === undefined
      ? undefined
      : data.error.kind === 'counts'
        ? t('countsUnavailable')
        : t('loadError', { error: data.error.message })

  const empty =
    view.grouping === 'none'
      ? (data.flat?.items.length ?? 0) === 0
      : (data.total ?? 0) === 0 && data.error === undefined

  return (
    <>
      {/* 툴바 — 무엇을 볼 것인가(필터)와 어떻게 볼 것인가(표시). */}
      <div className="flex flex-wrap items-center gap-2">
        <IssueFilterMenu
          filters={view.filters}
          directories={directories}
          projects={projects}
          cycles={cycles}
          onToggle={(facet, value) => {
            // 공용 메뉴는 축을 문자열로 돌려준다 — 이슈가 아는 축인지 여기서 좁힌다(단언 대신).
            const known = ISSUE_FILTER_FACETS.find((candidate) => candidate === facet)
            if (known === undefined) return
            apply({ ...view, filters: toggleIssueFilter(view.filters, known, value) })
          }}
          onClear={() => apply({ ...view, filters: {} })}
        />
        <div className="ml-auto flex items-center gap-2">
          {data.total !== undefined && (
            <span className="text-[12px] tabular-nums text-muted-foreground">
              {t('totalCount', { count: data.total })}
            </span>
          )}
          <IssueDisplayMenu display={view} onChange={(next) => apply({ ...view, ...next })} />
        </div>
      </div>
      {chips}

      {/* 새 목록을 기다리는 동안 이전 목록이 그대로 서 있는다 — 스켈레톤으로 비우면 방금 본 것이 사라진다. */}
      <div
        aria-busy={pending}
        className={cn('transition-opacity duration-150', pending && 'opacity-55')}
      >
        {error ? (
          <Callout tone="danger">{error}</Callout>
        ) : empty ? (
          <EmptyState
            icon={<CircleDot strokeWidth={1.75} />}
            title={
              base.cycle !== undefined
                ? t('cycleEmptyTitle')
                : base.triage === true
                  ? t('triageEmptyTitle')
                  : t('emptyTitle')
            }
            hint={
              base.cycle !== undefined
                ? t('cycleEmptyHint')
                : base.triage === true
                  ? t('triageEmptyHint')
                  : t('emptyHint')
            }
          />
        ) : view.grouping === 'none' ? (
          <FlatIssues
            workspace={workspace}
            data={data}
            directories={directories}
            canWrite={canWrite}
            timeZone={timeZone}
          />
        ) : data.groupBy !== undefined && view.layout === 'board' ? (
          <IssueBoard
            workspace={workspace}
            groupBy={data.groupBy}
            columns={data.groups.map(
              (group): IssueBoardColumn => ({
                key: group.key,
                count: group.count,
                items: group.items,
                truncated: group.nextCursor !== undefined,
              })
            )}
            directories={directories}
            canWrite={canWrite}
          />
        ) : data.groupBy !== undefined ? (
          <div className="space-y-3">
            {data.groups.map((group) => (
              <IssueGroup
                key={group.key ?? 'unset'}
                workspace={workspace}
                groupBy={data.groupBy ?? 'status'}
                groupKey={group.key}
                count={group.count}
                initial={group.items}
                {...(group.nextCursor !== undefined ? { initialCursor: group.nextCursor } : {})}
                query={group.query}
                directories={directories}
                canWrite={canWrite}
                timeZone={timeZone}
              />
            ))}
          </div>
        ) : null}

        {/* 조용한 상한은 "전부 봤다"로 읽힌다 — 몇 그룹을 안 세웠는지 말한다. */}
        {data.droppedGroups > 0 && (
          <p className="pt-3 text-[11.5px] text-muted-foreground">
            {t('groupsTruncated', { count: data.droppedGroups })}
          </p>
        )}
      </div>
      {footer}
    </>
  )
}

// 묶지 않은 목록의 한 장과 그 다음 장들. 예전에는 커서를 주소에 실은 링크였는데, 그러면 「더 보기」 한 번이
// 라우트를 다시 그렸고 지금까지 읽던 자리도 잃었다 — 그룹의 「더 보기」와 같은 방식으로 이어 붙인다.
function FlatIssues({
  workspace,
  data,
  directories,
  canWrite,
  timeZone,
}: {
  workspace: string
  data: IssueViewData
  directories: IssueDirectories
  canWrite: boolean
  timeZone: string
}) {
  const t = useTranslations('issuesPage')
  const [items, setItems] = useState<IssueSummary[]>(data.flat?.items ?? [])
  const [cursor, setCursor] = useState(data.flat?.nextCursor)
  const [loading, setLoading] = useState(false)

  // 서버가 새로 그린 첫 장이 진실이다 — 보기가 바뀌면 더 불러온 행은 사라져야 한다(그 목록에 속하지 않는다).
  const [seen, setSeen] = useState(data.flat)
  if (seen !== data.flat) {
    setSeen(data.flat)
    setItems(data.flat?.items ?? [])
    setCursor(data.flat?.nextCursor)
  }

  function loadMore() {
    const query = data.flatQuery
    if (query === undefined || cursor === undefined || loading) return
    setLoading(true)
    void loadIssuePageAction({ ...query, cursor }).then((result) => {
      setLoading(false)
      if (!result.ok) return
      setItems((prev) => [...prev, ...result.page.items])
      setCursor(result.page.nextCursor)
    })
  }

  return (
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
        <div className="pt-1">
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="inline-flex items-center rounded-lg border border-border px-3 py-1.5 text-[12px] font-[510] text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-60"
          >
            {t('loadMore')}
          </button>
        </div>
      )}
    </div>
  )
}
