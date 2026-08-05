'use client'

import { useState } from 'react'
import { useRefresh } from '@/shared/lib/use-refresh'
import { ChevronDown, Loader2, Users } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { cn } from '@/shared/lib/utils'
import { DropdownItem, DropdownLabel, DropdownMenu } from '@/shared/ui/dropdown-menu'

import { moveToTeamAction, type MoveToTeamKind } from '../api/move-to-team'

export interface TeamOption {
  id: string
  key: string
  name: string
}

// 소유 팀을 보여주고, 바꿀 수 있으면 그 자리에서 바꾸는 컨트롤 — 집 규칙대로 아이콘 + 드롭다운이지
// 텍스트 링크가 아니다. 상세의 메타 스트립 안에 앉으므로 스트립의 다른 항목과 같은 밀도로 그린다.
//
// 열려면 서버와 같은 두 조건을 통과해야 한다: 지금 소유한 팀에 쓸 수 있고(아니면 남의 팀 것을 빼오는 셈),
// 앞에 세울 수 있는 다른 팀이 있어야 한다(아니면 남의 팀에 떠넘기는 셈). 소유자 없는 자원은 출발 팀 검사가
// 없다 — 워크스페이스의 것은 누구든 정리할 수 있다.
export function TeamOwnerControl({
  kind,
  id,
  teamId,
  teams,
  writableIds,
  showLabel = true,
}: {
  kind: MoveToTeamKind
  id: string
  // 없으면 소유자 없음 — `_shared` 시드이거나 팀 축 이전에 등록된 것. "워크스페이스 것"이라는 뜻이지
  // "모두의 것"이 아니다.
  teamId?: string
  teams: TeamOption[]
  writableIds: string[]
  // 호스트가 이미 라벨을 그렸으면(하네스 상세의 MetaItem) 끈다 — 한 줄에 "팀 팀 ENG"가 되지 않도록.
  showLabel?: boolean
}) {
  const t = useTranslations('teamOwner')
  const refresh = useRefresh()
  const [pending, setPending] = useState(false)

  const current = teams.find((team) => team.id === teamId)
  // 내가 속하지 않은 팀이 소유했더라도 이름은 보인다(읽기는 로스터의 일이 아니다). 목록에 없는 것은
  // 비공개 팀뿐이고, 그때는 키 대신 "다른 팀"이라고만 말한다 — 화면이 팀 이름을 지어내지 않는다.
  const label = current?.key ?? (teamId !== undefined ? t('otherTeam') : t('unowned'))
  const destinations = teams.filter(
    (team) => team.id !== teamId && writableIds.includes(team.id)
  )
  const canMove =
    destinations.length > 0 && (teamId === undefined || writableIds.includes(teamId))

  function move(to: TeamOption) {
    void (async () => {
      setPending(true)
      try {
        const r = await moveToTeamAction(kind, id, to.id)
        if (!r.ok) {
          // 거절은 제어 평면의 말 그대로 — 다음 수를 화면이 지어내지 않는다.
          toast.error(r.error ?? t('error'))
          return
        }
        toast.success(t('moved', { team: to.key }))
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  if (!canMove) {
    return (
      <span className="inline-flex items-center gap-1.5" title={current?.name}>
        <Users className="size-3.5 text-faint" />
        {showLabel && t('label')} <span className="font-[560] text-foreground">{label}</span>
      </span>
    )
  }

  return (
    <DropdownMenu
      align="start"
      trigger={({ toggle }) => (
        <button
          type="button"
          onClick={toggle}
          disabled={pending}
          title={current?.name ?? t('changeHint')}
          className={cn(
            '-mx-1 inline-flex items-center gap-1.5 rounded-sm px-1 py-0.5 transition-colors',
            'hover:bg-secondary hover:text-foreground disabled:opacity-60'
          )}
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin text-faint" />
          ) : (
            <Users className="size-3.5 text-faint" />
          )}
          {showLabel && t('label')}{' '}
          <span className="font-[560] text-foreground">{label}</span>
          <ChevronDown className="size-3 text-faint" />
        </button>
      )}
    >
      <DropdownLabel>{t('moveTo')}</DropdownLabel>
      {destinations.map((team) => (
        <DropdownItem key={team.id} onSelect={() => move(team)}>
          <span className="font-mono text-[11px] uppercase text-muted-foreground">{team.key}</span>{' '}
          {team.name}
        </DropdownItem>
      ))}
    </DropdownMenu>
  )
}
