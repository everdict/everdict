'use client'

import { UserRound } from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  IssuePriorityIcon,
  IssueStatusIcon,
  type IssueGroupBy,
} from '@/entities/issue'
import { memberNameOf } from '@/entities/member'
import { Avatar } from '@/shared/ui/avatar'

import type { IssueDirectories } from '../model/directories'

// One group's name plate — an icon plus the name. It resolves the different vocabularies of each axis in ONE place: status and priority are a
// closed vocabulary and come from the catalog; people, projects and cycles come from the directory join. `null` is the unspecified bucket and it
// needs a name too — a nameless group reads as a fault.
export function IssueGroupLabel({
  groupBy,
  groupKey,
  directories,
}: {
  groupBy: IssueGroupBy
  groupKey: string | null
  directories: IssueDirectories
}) {
  const t = useTranslations('issuesPage')
  const tracker = useTranslations('tracker')

  if (groupKey === null)
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <UserRound className="size-3.5 text-faint" strokeWidth={1.75} aria-hidden />
        <span className="truncate">{t(`groupUnset.${groupBy}`)}</span>
      </span>
    )

  if (groupBy === 'status') {
    // Narrowed because it is a CLOSED vocabulary — using the server's string directly as a catalog key eventually puts a missing key on screen.
    const status = ISSUE_STATUSES.find((s) => s === groupKey)
    if (status === undefined) return <span className="truncate">{groupKey}</span>
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <IssueStatusIcon status={status} className="[&_svg]:size-3.5" />
        <span className="truncate">{tracker(`issueStatus.${status}`)}</span>
      </span>
    )
  }

  if (groupBy === 'priority') {
    const priority = ISSUE_PRIORITIES.find((p) => p === groupKey)
    if (priority === undefined) return <span className="truncate">{groupKey}</span>
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <IssuePriorityIcon priority={priority} className="[&_svg]:size-3.5" />
        <span className="truncate">{tracker(`issuePriority.${priority}`)}</span>
      </span>
    )
  }

  if (groupBy === 'assignee') {
    const name = memberNameOf(directories.actors, groupKey)
    const avatarUrl = directories.actors[groupKey]?.avatarUrl
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Avatar name={name} size="sm" {...(avatarUrl !== undefined ? { url: avatarUrl } : {})} />
        <span className="truncate">{name}</span>
      </span>
    )
  }

  const name = directories.projectName[groupKey]
  // With no name found, the id is shown — better than an issue pointing at a deleted project losing its whole group.
  return <span className="truncate">{name ?? groupKey}</span>
}
