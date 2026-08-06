'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { useRefresh } from '@/shared/lib/use-refresh'
import { Button } from '@/shared/ui/button'

import { joinTeamAction, leaveTeamAction } from '../api/manage-team'

// 팀 디렉터리와 설정 › 팀 목록이 공유하는 "참여/나가기" 컨트롤(리니어의 Join teams). 자기 자신만 움직이는
// 셀프 서비스라 대상 subject 가 없고, joined 는 서버 렌더가 mine 목록으로 판정해 내려준다 — 클라이언트가
// 로스터를 다시 세지 않는다. 사이드바의 "Your teams" 도 refresh() 한 번으로 따라온다(레이아웃까지 다시 그림).
export function TeamJoinControl({ teamId, joined }: { teamId: string; joined: boolean }) {
  const t = useTranslations('teamsDirectory')
  const refresh = useRefresh()
  const [pending, setPending] = useState(false)

  function toggle() {
    void (async () => {
      setPending(true)
      try {
        const r = joined ? await leaveTeamAction(teamId) : await joinTeamAction(teamId)
        if (!r.ok) {
          toast.error(r.error ?? t(joined ? 'leaveError' : 'joinError'))
          return
        }
        refresh()
      } finally {
        setPending(false)
      }
    })()
  }

  return (
    <Button
      variant={joined ? 'outline' : 'secondary'}
      size="xs"
      disabled={pending}
      onClick={toggle}
    >
      {joined ? t('leave') : t('join')}
    </Button>
  )
}
