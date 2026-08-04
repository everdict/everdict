'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, Loader2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { issueHref } from '@/entities/issue'
import { TeamKeyBadge } from '@/entities/team'
import { DropdownItem, DropdownLabel, DropdownMenu } from '@/shared/ui/dropdown-menu'

import { moveIssueAction } from '../api/issues'

export interface IssueTeamOption {
  id: string
  key: string
  name: string
}

// 이슈의 팀 — 상태와 함께, 속성 열 안에 컨트롤이 사는 둘뿐인 속성이다(팀을 바꾸는 것이 곧 그 속성을 바꾸는 것).
// 상태 컨트롤과 같은 문법: 배지 + 드롭다운, 텍스트 링크 줄이 아니다.
//
// 이동은 식별자를 다시 찍으므로 이 페이지의 주소 자체가 바뀐다 — router.refresh() 로는 예전 슬러그에 머물러
// (예전 이름도 해석되니 화면은 멀쩡하다) 주소창만 낡는다. 그래서 성공하면 새 식별자로 replace 한다.
export function IssueTeamControl({
  workspace,
  id,
  team,
  teams,
  canWrite,
}: {
  workspace: string
  id: string
  team: IssueTeamOption | undefined
  teams: IssueTeamOption[]
  canWrite: boolean
}) {
  const t = useTranslations('issuesPage')
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function move(teamId: string) {
    startTransition(async () => {
      const r = await moveIssueAction(id, teamId)
      if (!r.ok || !r.issue) {
        // 이미 그 팀이면 제어 평면의 409 — 도메인의 거절을 그대로 보여 준다.
        toast.error(r.error ?? t('moveError'))
        return
      }
      router.replace(issueHref(workspace, r.issue.identifier, r.issue.title))
      router.refresh()
    })
  }

  const label = team ? (
    <>
      <TeamKeyBadge teamKey={team.key} />
      <span className="truncate">{team.name}</span>
    </>
  ) : (
    <span className="truncate">{t('teamUnknown')}</span>
  )

  const others = teams.filter((x) => x.id !== team?.id)
  if (!canWrite || others.length === 0)
    return <span className="inline-flex min-w-0 items-center gap-1.5">{label}</span>

  return (
    <DropdownMenu
      align="end"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={t('teamControlLabel')}
          disabled={pending}
          className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : label}
          <ChevronDown className="size-3 shrink-0 text-faint" />
        </button>
      )}
    >
      <DropdownLabel>{t('teamMoveTo')}</DropdownLabel>
      {others.map((option) => (
        <DropdownItem
          key={option.id}
          icon={<TeamKeyBadge teamKey={option.key} />}
          onSelect={() => move(option.id)}
        >
          {option.name}
        </DropdownItem>
      ))}
    </DropdownMenu>
  )
}
