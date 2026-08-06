'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import { memberNameOf, type MemberDirectory } from '@/entities/member'
import type { TeamMember } from '@/entities/team'
import { useRefresh } from '@/shared/lib/use-refresh'
import { Avatar } from '@/shared/ui/avatar'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { EmptyState } from '@/shared/ui/empty-state'
import { MultiSelect } from '@/shared/ui/multi-select'

import { addTeamMembersAction, removeTeamMemberAction } from '../api/manage-team'

// 다른 팀의 로스터로 한 번에 고르는 빠른 선택의 재료 — 서버가 이미 팀별 멤버를 읽어 내려준다.
export interface TeamRosterGroup {
  id: string
  name: string
  subjects: string[]
}

// Settings › Teams › {team} › 멤버 — 이 팀의 로스터. 워크스페이스 멤버십과 별개다(팀 소속은 가시성의 진술이지
// 두 번째 인가 축이 아니다 — 그 구분은 탭 위 안내가 말한다).
export function TeamRoster({
  teamId,
  members,
  candidates,
  teamGroups,
  directory,
  canWrite,
}: {
  teamId: string
  members: TeamMember[]
  candidates: { value: string; label: string }[]
  // 다른 팀들의 로스터 — "저 팀 전체를 이 팀에도" 가 클릭 한 번이 되게 한다. 빈 배열이면 빠른 선택 줄이 안 선다.
  teamGroups: TeamRosterGroup[]
  // subject → 사람. 이 페이지는 서버에서 이미 워크스페이스 멤버를 읽으므로 클라이언트 조회를 또 하지 않는다.
  directory: MemberDirectory
  canWrite: boolean
}) {
  const t = useTranslations('manageTeams')
  const refresh = useRefresh()
  const [error, setError] = useState<string>()
  const [selection, setSelection] = useState<string[]>([])
  const [pending, setPending] = useState(false)

  // 화면 갱신은 부르는 쪽의 몫이다 — 서버 액션은 제어 평면에 쓰고 돌아올 뿐이다(`.claude/rules/web.md`).
  function act(run: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(undefined)
    void (async () => {
      setPending(true)
      try {
        const r = await run()
        if (!r.ok) {
          setError(r.error)
          return
        }
        after?.()
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  const onRoster = new Set(members.map((m) => m.subject))
  const addable = candidates.filter((c) => !onRoster.has(c.value))
  const addableSet = new Set(addable.map((c) => c.value))
  // 빠른 선택 버튼은 "지금 더 넣을 수 있는 사람"이 남은 팀만 세운다 — 눌러도 아무 일 없는 버튼은 고장으로 읽힌다.
  const quickTeams = teamGroups
    .map((g) => ({ ...g, addable: g.subjects.filter((s) => addableSet.has(s)) }))
    .filter((g) => g.addable.length > 0)

  // 선택은 합집합으로만 자란다 — 이미 고른 사람을 팀 버튼이 다시 빼는 일은 없다.
  function selectMore(subjects: string[]) {
    setSelection((prev) => [...new Set([...prev, ...subjects.filter((s) => addableSet.has(s))])])
  }

  function addSelected() {
    setError(undefined)
    void (async () => {
      setPending(true)
      try {
        const r = await addTeamMembersAction(teamId, selection)
        // 일부만 실패해도 성공분은 이미 로스터에 들어갔다 — 실패한 사람만 선택에 남기고 화면은 항상 갱신한다.
        setSelection(r.failed ?? [])
        if (!r.ok) setError(r.error)
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <div className="space-y-3">
      {error !== undefined && <Callout tone="danger">{error}</Callout>}

      {canWrite && addable.length > 0 && (
        // 추가는 목록 위에 둔다 — 리니어처럼 "누구를 넣을까"가 이 화면의 첫 동작이고, 로스터가 길어져도
        // 자리가 움직이지 않는다.
        <div className="space-y-2">
          {(quickTeams.length > 0 || addable.length > 1) && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11.5px] text-muted-foreground">{t('quickSelect')}</span>
              {addable.length > 1 && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={pending}
                  onClick={() => selectMore(addable.map((c) => c.value))}
                >
                  {t('selectAll')} ({addable.length})
                </Button>
              )}
              {quickTeams.map((g) => (
                <Button
                  key={g.id}
                  size="xs"
                  variant="outline"
                  disabled={pending}
                  aria-label={t('selectTeamAria', { name: g.name })}
                  onClick={() => selectMore(g.addable)}
                >
                  {g.name} ({g.addable.length})
                </Button>
              ))}
            </div>
          )}
          <MultiSelect
            options={addable}
            selected={selection}
            onChange={setSelection}
            placeholder={t('memberSearchPlaceholder')}
            emptyLabel={t('noAddableMembers')}
            removeLabel={(name) => t('unselectMember', { name })}
          />
          <Button size="md" disabled={selection.length === 0 || pending} onClick={addSelected}>
            {selection.length > 0 ? t('addCount', { count: selection.length }) : t('add')}
          </Button>
        </div>
      )}

      {members.length === 0 ? (
        <EmptyState title={t('rosterEmpty')} hint={t('rosterEmptyHint')} />
      ) : (
        <ul className="divide-y divide-border/70 overflow-hidden rounded-lg border bg-card shadow-raise">
          {members.map((m) => {
            // 로스터 행은 사람이다 — subject 는 불투명한 Keycloak sub 라서 그대로 두면 "누가 이 팀인지" 를
            // id 로 읽게 된다.
            const name = memberNameOf(directory, m.subject)
            return (
              <li key={m.subject} className="flex h-11 items-center gap-2.5 px-3">
                <Avatar name={name} url={directory[m.subject]?.avatarUrl} size="sm" />
                <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{name}</span>
                {canWrite && (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => act(() => removeTeamMemberAction(teamId, m.subject))}
                  >
                    {t('remove')}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
