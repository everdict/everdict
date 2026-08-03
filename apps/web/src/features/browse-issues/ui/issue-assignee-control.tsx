'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, UserRound } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { updateIssueAction } from '@/features/manage-issue'
import { memberNameOf, type MemberDirectory } from '@/entities/member'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import { DropdownItem, DropdownLabel, DropdownMenu, DropdownSeparator } from '@/shared/ui/dropdown-menu'

// 담당자 — 상태·우선순위와 같은 하우스 문법(아이콘 + 드롭다운)이고, 같은 이유로 목록 행 위에 산다: 담당자를
// 바꾸려고 이슈를 열었다 닫는 왕복이 리니어에는 없다. 워크플로 전이가 아니라 내용 편집이라 `updateIssue`
// 로 가고, 이력에는 `updated{changed:[assignee]}` 한 줄로 남는다.
export function IssueAssigneeControl({
  id,
  assignee,
  actors,
  // 고를 수 있는 사람들 — 워크스페이스 멤버 목록. 디렉터리는 이미 나간 사람의 이름까지 알지만, 고를 수
  // 있는 건 지금 멤버인 사람뿐이다.
  members,
  canWrite,
  className,
}: {
  id: string
  assignee?: string
  actors: MemberDirectory
  members: { subject: string; name: string; avatarUrl?: string }[]
  canWrite: boolean
  className?: string
}) {
  const t = useTranslations('issuesPage')
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function set(next: string | null) {
    startTransition(async () => {
      const r = await updateIssueAction(id, { assignee: next })
      if (!r.ok) {
        toast.error(r.error ?? t('assigneeError'))
        return
      }
      router.refresh()
    })
  }

  const face =
    assignee === undefined ? (
      // 담당자 없음도 그려야 하는 답이다 — 빈 자리는 "아직 아무도"라고 말하지 못한다.
      <span className="inline-flex size-5 items-center justify-center rounded-full border border-dashed border-border text-faint">
        <UserRound className="size-3" strokeWidth={1.75} aria-hidden />
      </span>
    ) : (
      <Avatar
        name={memberNameOf(actors, assignee)}
        size="sm"
        {...(actors[assignee]?.avatarUrl !== undefined ? { url: actors[assignee].avatarUrl } : {})}
      />
    )

  if (!canWrite)
    return (
      <span
        className={cn('inline-flex items-center', className)}
        title={assignee === undefined ? t('fieldAssigneeNone') : memberNameOf(actors, assignee)}
      >
        {face}
      </span>
    )

  return (
    <DropdownMenu
      align="end"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={t('assigneeControlLabel')}
          title={assignee === undefined ? t('fieldAssigneeNone') : memberNameOf(actors, assignee)}
          disabled={pending}
          className={cn(
            'inline-flex items-center rounded-full p-0.5 transition-colors hover:bg-accent disabled:opacity-50',
            className
          )}
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : face}
        </button>
      )}
    >
      <DropdownLabel>{t('assigneeSetTo')}</DropdownLabel>
      {members
        .filter((member) => member.subject !== assignee)
        .map((member) => (
          <DropdownItem
            key={member.subject}
            icon={
              <Avatar
                name={member.name}
                size="sm"
                {...(member.avatarUrl !== undefined ? { url: member.avatarUrl } : {})}
              />
            }
            onSelect={() => set(member.subject)}
          >
            {member.name}
          </DropdownItem>
        ))}
      {assignee !== undefined && (
        <>
          <DropdownSeparator />
          <DropdownItem icon={<UserRound className="size-3.5" />} onSelect={() => set(null)}>
            {t('assigneeClear')}
          </DropdownItem>
        </>
      )}
    </DropdownMenu>
  )
}
