'use client'

import { useState } from 'react'
import { Check, ChevronDown, Loader2, UserRound } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { memberNameOf, type MemberDirectory } from '@/entities/member'
import { useRefresh } from '@/shared/lib/use-refresh'
import { cn } from '@/shared/lib/utils'
import { Avatar } from '@/shared/ui/avatar'
import {
  DropdownItem,
  DropdownLabel,
  DropdownMenu,
  DropdownSeparator,
} from '@/shared/ui/dropdown-menu'
import { Input } from '@/shared/ui/input'

import { updateIssueAction } from '../api/issues'

// 고를 것이 이만큼 넘어가면 검색 줄을 낸다 — 프로젝트·상위 이슈 선택기와 같은 문턱값. 사람은 목록 중에서도
// 가장 빨리 길어지는 축이라(멤버가 늘면 계속 는다) 스크롤로만 찾게 두지 않는다.
const SEARCH_FROM = 7

// 담당자 — 상태·우선순위와 같은 하우스 문법(아이콘 + 드롭다운)이고, 같은 이유로 목록 행과 상세의 속성 열
// 양쪽에 산다: 담당자를 바꾸려고 이슈를 열었다 닫는 왕복도, 이슈를 열어 놓고 담당자만은 목록으로 돌아가
// 바꾸는 왕복도 리니어에는 없다. 워크플로 전이가 아니라 내용 편집이라 `updateIssue` 로 가고, 이력에는
// `updated{changed:[assignee]}` 한 줄로 남는다.
export function IssueAssigneeControl({
  id,
  assignee,
  actors,
  // 고를 수 있는 사람들 — 워크스페이스 멤버 목록. 디렉터리는 이미 나간 사람의 이름까지 알지만, 고를 수
  // 있는 건 지금 멤버인 사람뿐이다.
  members,
  canWrite,
  variant = 'default',
  className,
}: {
  id: string
  assignee?: string
  actors: MemberDirectory
  members: { subject: string; name: string; avatarUrl?: string }[]
  canWrite: boolean
  // 상태·우선순위 컨트롤과 같은 두 밀도 — 목록 행에서는 얼굴만, 속성 열에서는 이름까지 선다(속성 열은
  // 훑는 자리가 아니라 읽는 자리라, 얼굴만으로 누구인지 맞히게 하지 않는다).
  variant?: 'default' | 'icon'
  className?: string
}) {
  const t = useTranslations('issuesPage')
  const refresh = useRefresh()
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)

  // `null` 은 비운다 — 담당자를 뗀다는 뜻이고, `undefined`(손대지 않음)와 절대 섞이면 안 된다.
  function set(next: string | null): void {
    if (next === (assignee ?? null)) return
    void (async () => {
      setPending(true)
      try {
        const r = await updateIssueAction(id, { assignee: next })
        if (!r.ok) {
          toast.error(r.error ?? t('assigneeError'))
          return
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  const name = assignee === undefined ? t('fieldAssigneeNone') : memberNameOf(actors, assignee)
  const face =
    assignee === undefined ? (
      // 담당자 없음도 그려야 하는 답이다 — 빈 자리는 "아직 아무도"라고 말하지 못한다.
      <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-faint">
        <UserRound className="size-3" strokeWidth={1.75} aria-hidden />
      </span>
    ) : (
      <Avatar
        name={name}
        size="sm"
        {...(actors[assignee]?.avatarUrl !== undefined ? { url: actors[assignee].avatarUrl } : {})}
      />
    )

  if (!canWrite)
    return variant === 'icon' ? (
      <span className={cn('inline-flex items-center', className)} title={name}>
        {face}
      </span>
    ) : (
      <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
        {face}
        <span className={cn('truncate', assignee === undefined && 'text-muted-foreground')}>
          {name}
        </span>
      </span>
    )

  const needle = query.trim().toLocaleLowerCase()
  const choices = members.filter(
    (member) => needle === '' || member.name.toLocaleLowerCase().includes(needle)
  )
  const searchable = members.length > SEARCH_FROM

  return (
    <DropdownMenu
      align="end"
      contentClassName={cn(searchable && 'w-64 p-1')}
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={t('assigneeControlLabel')}
          title={variant === 'icon' ? name : undefined}
          disabled={pending}
          className={cn(
            'transition-colors disabled:opacity-50',
            variant === 'icon'
              ? 'inline-flex items-center rounded-full p-0.5 hover:bg-accent'
              : 'inline-flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-accent hover:text-foreground',
            className
          )}
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : face}
          {variant === 'default' && (
            <>
              <span className={cn('truncate', assignee === undefined && 'text-muted-foreground')}>
                {name}
              </span>
              <ChevronDown className="size-3 shrink-0 text-faint" />
            </>
          )}
        </button>
      )}
    >
      {searchable ? (
        <div className="p-1">
          <Input
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('assigneeSearchPlaceholder')}
            // 이 컨트롤이 폼 안에 놓이는 날을 대비한다 — Enter 가 폼을 제출해 버리면 고르다 말고 저장된다.
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.preventDefault()
            }}
          />
        </div>
      ) : (
        <DropdownLabel>{t('assigneeSetTo')}</DropdownLabel>
      )}
      <div className="max-h-56 overflow-y-auto">
        {choices.map((member) => (
          <DropdownItem
            key={member.subject}
            icon={
              <Avatar
                name={member.name}
                size="sm"
                {...(member.avatarUrl !== undefined ? { url: member.avatarUrl } : {})}
              />
            }
            {...(member.subject === assignee ? { trailing: <Check className="size-3.5" /> } : {})}
            onSelect={() => set(member.subject)}
          >
            {member.name}
          </DropdownItem>
        ))}
        {choices.length === 0 && (
          <p className="px-2 py-1.5 text-[12px] text-faint">{t('assigneeNoMatch')}</p>
        )}
      </div>
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
