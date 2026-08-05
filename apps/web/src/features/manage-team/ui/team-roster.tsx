'use client'

import { useState } from 'react'
import { useRefresh } from '@/shared/lib/use-refresh'
import { useTranslations } from 'next-intl'

import { memberNameOf, type MemberDirectory } from '@/entities/member'
import type { TeamMember } from '@/entities/team'
import { Avatar } from '@/shared/ui/avatar'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { EmptyState } from '@/shared/ui/empty-state'

import { addTeamMemberAction, removeTeamMemberAction } from '../api/manage-team'

// Settings › Teams › {team} › 멤버 — 이 팀의 로스터. 워크스페이스 멤버십과 별개다(팀 소속은 가시성의 진술이지
// 두 번째 인가 축이 아니다 — 그 구분은 탭 위 안내가 말한다).
export function TeamRoster({
  teamId,
  members,
  candidates,
  directory,
  canWrite,
}: {
  teamId: string
  members: TeamMember[]
  candidates: { value: string; label: string }[]
  // subject → 사람. 이 페이지는 서버에서 이미 워크스페이스 멤버를 읽으므로 클라이언트 조회를 또 하지 않는다.
  directory: MemberDirectory
  canWrite: boolean
}) {
  const t = useTranslations('manageTeams')
  const refresh = useRefresh()
  const [error, setError] = useState<string>()
  const [addSubject, setAddSubject] = useState('')
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

  return (
    <div className="space-y-3">
      {error !== undefined && <Callout tone="danger">{error}</Callout>}

      {canWrite && addable.length > 0 && (
        // 추가는 목록 위에 둔다 — 리니어처럼 "누구를 넣을까"가 이 화면의 첫 동작이고, 로스터가 길어져도
        // 자리가 움직이지 않는다. (`@container` 를 자기 자신에 걸고 `@sm:` 을 같은 요소에 쓰면 절대 매치되지
        // 않는다 — 예전 폼이 세로로 눌린 채 버튼만 가로로 늘어나 있던 이유다.)
        <div className="@container">
          <div className="flex flex-col gap-2 @sm:flex-row">
            <Combobox
              value={addSubject}
              onChange={setAddSubject}
              options={addable}
              placeholder={t('addMemberPlaceholder')}
              className="min-w-0 flex-1"
            />
            <Button
              size="md"
              className="shrink-0 self-start"
              disabled={addSubject === '' || pending}
              onClick={() =>
                act(
                  () => addTeamMemberAction(teamId, addSubject),
                  () => setAddSubject('')
                )
              }
            >
              {t('add')}
            </Button>
          </div>
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
