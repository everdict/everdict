'use client'

import { memo } from 'react'
import Link from 'next/link'
import { MessageSquare } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import { IssuePriorityControl, IssueStatusControl } from '@/features/manage-issue'
import { isOpenIssueStatus, issueHref, type IssueSummary } from '@/entities/issue'
import { IssueLabelChips } from '@/entities/issue-label'
import { isPastDue } from '@/entities/project'
import { fmtTimeAgo } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'

import type { IssueDirectories } from '../model/directories'
import { IssueAssigneeControl } from './issue-assignee-control'

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

  return (
    <div
      className={cn(
        'group flex items-center gap-2 rounded-lg border bg-card px-2.5 py-2 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated',
        // A regression is the one row that has to catch the eye across the whole list.
        issue.status === 'regressed' && 'border-destructive/40 bg-destructive/5'
      )}
    >
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
      <Link href={issueHref(workspace, issue.identifier)} className="min-w-0 flex-1">
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
            isOpenIssueStatus(issue.status) && isPastDue(issue.dueDate, timeZone) && 'text-destructive'
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
        className="shrink-0"
      />
    </div>
  )
})
