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

// 그룹 하나의 이름표 — 아이콘 + 이름. 축마다 다른 어휘를 한 곳에서 푼다: 상태·우선순위는 닫힌 어휘라
// 카탈로그에서, 사람·프로젝트·사이클은 디렉터리 조인에서 온다. `null` 은 미지정 버킷이고 그것도 이름이
// 있어야 한다 — 이름 없는 그룹은 고장으로 읽힌다.
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
    // 닫힌 어휘라 좁힌다 — 서버가 보낸 문자열을 그대로 카탈로그 키로 쓰면, 언젠가 없는 키가 화면에 뜬다.
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
  // 이름을 못 찾으면 id 를 낸다 — 삭제된 프로젝트를 가리키는 이슈가 그룹을 통째로 잃는 것보다 낫다.
  return <span className="truncate">{name ?? groupKey}</span>
}
