'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'

import { leaveWorkspaceAction } from '../api/leave-workspace'

// 이 워크스페이스에서 나가기 — Linear "Workspace access" 패턴(설명 좌 · 액션 우).
// 2단계 확인(잘못 누름 방지). 성공 시 홈(/)으로 보내 남은 워크스페이스/온보딩으로 재라우팅.
// 마지막 admin 은 컨트롤플레인이 409 로 막고, 그 메시지를 인라인으로 보여준다.
export function LeaveWorkspaceButton() {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, startTransition] = useTransition()

  function onLeave() {
    setError(undefined)
    startTransition(async () => {
      const r = await leaveWorkspaceAction()
      if (r.ok) {
        router.push('/')
        router.refresh()
      } else {
        setConfirming(false)
        setError(r.error ?? '나가기에 실패했습니다.')
      }
    })
  }

  return (
    <div className="space-y-2.5">
      <h3 className="px-1 text-[13px] font-[560] text-foreground">워크스페이스 접근</h3>
      <SettingsList>
        <SettingsRow label="이 워크스페이스에서 나가기">
          {confirming ? (
            <>
              <button
                type="button"
                className="text-[12px] text-muted-foreground hover:text-foreground"
                onClick={() => setConfirming(false)}
                disabled={pending}
              >
                취소
              </button>
              <Button variant="destructive" size="sm" onClick={onLeave} disabled={pending}>
                {pending ? '나가는 중…' : '정말 나가기'}
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
              나가기
            </Button>
          )}
        </SettingsRow>
      </SettingsList>
      {error && <Callout tone="danger">{error}</Callout>}
    </div>
  )
}
