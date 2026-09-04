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

// One list row. It differs from the old row in exactly one way, and that is Linear's central speed: status, priority and assignee are changed
// **here**. Which is why the whole row cannot be a `<Link>` — a button inside a link is not valid markup either, and the click that opens a
// dropdown would navigate to the issue. Only the title area is the link and the controls stand as its SIBLINGS (the same composition as Linear).
// The row's stable identity in the DOM. It survived the bulk-selection feature it was written for — that
// feature's only action was "move these into this cycle", and cycles went with teams — because a test and a
// future range-select both address a row by it rather than by position.
export const ISSUE_ROW_ATTR = 'data-issue-id'

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
      {...{ [ISSUE_ROW_ATTR]: issue.id }}
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
      <Link href={issueHref(workspace, issue.identifier, issue.title)} className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-2">
          {/* The name people call it by — `EVD-12`. Stamped by the workspace and stored on the issue. */}
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
          {/* Only when there IS conversation — "0 comments" seen every day is noise (the same rule as empty-section hiding). */}
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
        {/* Time in a list is RELATIVE — on a screen you sweep, what you want to know is "how long ago" rather than "when". */}
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
