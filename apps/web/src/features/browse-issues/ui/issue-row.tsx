'use client'

import { memo } from 'react'
import { MessageSquare } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import {
  IssueAssigneeControl,
  IssuePriorityControl,
  IssueStatusControl,
} from '@/features/manage-issue'
import { isOpenIssueStatus, issueHref, type IssueSummary } from '@/entities/issue'
import { IssueLabelChips } from '@/entities/issue-label'
import { isPastDue } from '@/entities/project'
import { fmtTimeAgo } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Link } from '@/shared/ui/link'

import type { IssueDirectories } from '../model/directories'
import { ISSUE_ROW_ATTR, useIssueSelection } from '../model/issue-selection'

// 목록 한 줄. 예전 행과 다른 점은 하나뿐이지만 그게 리니어의 핵심 속도다: 상태·우선순위·담당자를 **여기서**
// 바꾼다. 그래서 행 전체가 `<Link>` 일 수 없다 — 링크 안의 버튼은 유효한 마크업도 아니고, 드롭다운을 여는
// 클릭이 이슈로 이동해 버린다. 제목 영역만 링크이고 컨트롤은 그 형제로 선다(리니어와 같은 구성).
export const IssueRow = memo(function IssueRow({
  workspace,
  issue,
  directories,
  canWrite,
  timeZone,
}: {
  workspace: string
  issue: IssueSummary
  directories: IssueDirectories
  canWrite: boolean
  timeZone: string
}) {
  const t = useTranslations('issuesPage')
  const locale = useLocale()
  // 고르기가 있는 목록(팀 스코프)에서만 컨텍스트가 있다 — 없으면 예전 그대로의 행이다.
  const selection = useIssueSelection()
  const picked = selection?.selected.has(issue.id) ?? false
  const picking = selection?.selectionMode ?? false

  return (
    <div
      {...{ [ISSUE_ROW_ATTR]: issue.id }}
      className={cn(
        'group flex items-center gap-2 rounded-lg border bg-card px-2.5 py-2 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated',
        // A regression is the one row that has to catch the eye across the whole list.
        issue.status === 'regressed' && 'border-destructive/40 bg-destructive/5',
        picked && 'border-[var(--color-link)]/50 bg-[var(--color-link)]/5'
      )}
    >
      {/* 체크박스는 호버(또는 고르는 중)에만 드러난다 — 평소의 목록에 상시 체크박스 열이 서면 훑는 화면이
          작업 화면처럼 무거워진다. 자리는 늘 차지하므로 드러날 때 행이 밀리지 않는다. */}
      {selection && (
        <label
          className={cn(
            'flex size-4 shrink-0 cursor-pointer items-center justify-center transition-opacity',
            picking || picked
              ? 'opacity-100'
              : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100'
          )}
        >
          <input
            type="checkbox"
            checked={picked}
            aria-label={t('selectRow', { identifier: issue.identifier })}
            onChange={(e) =>
              selection.toggle(
                issue.id,
                'nativeEvent' in e ? (e.nativeEvent as MouseEvent).shiftKey : false
              )
            }
            onClick={(e) => e.stopPropagation()}
            className="size-3.5 accent-[var(--color-link)]"
          />
        </label>
      )}
      <IssueStatusControl
        id={issue.id}
        status={issue.status}
        canWrite={canWrite}
        scorecards={[]}
        variant="icon"
      />
      <IssuePriorityControl
        id={issue.id}
        priority={issue.priority}
        canWrite={canWrite}
        variant="icon"
      />
      {/* 고르는 중에는 제목 클릭이 이슈를 열지 않고 토글한다 — 스무 건을 고르는 도중 한 번의 오클릭으로
          화면이 통째로 바뀌면 고른 것이 전부 사라진다(스코어카드 목록과 같은 규칙). */}
      <Link
        href={issueHref(workspace, issue.identifier, issue.title)}
        className="min-w-0 flex-1"
        onClick={(e) => {
          if (!picking || !selection) return
          e.preventDefault()
          selection.toggle(issue.id, e.shiftKey)
        }}
      >
        <p className="flex min-w-0 items-baseline gap-2">
          {/* 사람이 부르는 이름 — `ENG-12`. 팀이 찍어 이슈에 저장된 값이라 팀을 다시 읽지 않는다. */}
          <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
            {issue.identifier}
          </span>
          <span className="truncate text-[13px] font-[510] text-foreground">{issue.title}</span>
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
          {issue.projectId && (
            <span className="truncate">
              {directories.projectName[issue.projectId] ?? issue.projectId}
            </span>
          )}
          <IssueLabelChips labelIds={issue.labelIds} directory={directories.labels} />
          {issue.linkCount > 0 && <span>{t('rowLinkCount', { count: issue.linkCount })}</span>}
          {/* 대화가 있을 때만 — 「댓글 0」은 매일 보면 노이즈다(빈 섹션 숨김과 같은 규칙). */}
          {issue.commentCount !== undefined && issue.commentCount > 0 && (
            <span
              className="inline-flex items-center gap-0.5"
              title={t('rowCommentCount', { count: issue.commentCount })}
            >
              <MessageSquare className="size-3" strokeWidth={1.75} aria-hidden />
              <span className="tabular-nums">{issue.commentCount}</span>
            </span>
          )}
          {issue.estimate !== undefined && (
            <span className="font-mono tabular-nums">{issue.estimate}</span>
          )}
        </p>
      </Link>
      {issue.dueDate !== undefined && (
        <time
          dateTime={issue.dueDate}
          className={cn(
            'hidden shrink-0 font-mono text-[11px] text-muted-foreground @md:block',
            isOpenIssueStatus(issue.status) &&
              isPastDue(issue.dueDate, timeZone) &&
              'text-destructive'
          )}
        >
          {issue.dueDate}
        </time>
      )}
      <time
        dateTime={issue.updatedAt}
        title={issue.updatedAt}
        className="hidden shrink-0 font-mono text-[11px] text-muted-foreground @lg:block"
      >
        {/* 목록의 시간은 상대적이다 — 훑는 화면에서 알고 싶은 건 "언제"가 아니라 "얼마나 됐나"다. */}
        {fmtTimeAgo(issue.updatedAt, locale, timeZone)}
      </time>
      <IssueAssigneeControl
        id={issue.id}
        {...(issue.assignee !== undefined ? { assignee: issue.assignee } : {})}
        actors={directories.actors}
        members={directories.members}
        canWrite={canWrite}
        variant="icon"
        className="shrink-0"
      />
    </div>
  )
})
