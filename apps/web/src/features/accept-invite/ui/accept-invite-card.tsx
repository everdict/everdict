'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'

import { acceptInviteAction } from '../api/accept-invite'

// 초대 수락 카드. GET 자동 수락을 피하려 명시적 버튼(POST 서버 액션)으로만 redeem — prefetch 가 일회용 토큰을 소진하지 않게.
export function AcceptInviteCard({ token }: { token: string }) {
  const router = useRouter()
  const [error, setError] = useState<string>()
  const [done, setDone] = useState<{ workspace: string; role: string }>()
  const [pending, startTransition] = useTransition()

  function onAccept() {
    setError(undefined)
    startTransition(async () => {
      const r = await acceptInviteAction(token)
      if (r.ok && r.workspace && r.role) {
        setDone({ workspace: r.workspace, role: r.role })
        router.refresh()
      } else {
        setError(r.error ?? '수락 실패')
      }
    })
  }

  if (done) {
    return (
      <div className="space-y-4">
        <Callout tone="info">
          <span className="font-[510]">
            워크스페이스 <span className="font-mono">{done.workspace}</span> 에 {done.role} 로
            가입했습니다.
          </span>
        </Callout>
        <Button onClick={() => router.push('/dashboard')}>대시보드로 이동</Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        이 초대를 수락하면 해당 워크스페이스의 멤버가 되고, 현재 활성 워크스페이스가 그곳으로
        전환됩니다.
      </p>
      <div className="flex items-center gap-2.5">
        <Button onClick={onAccept} disabled={pending}>
          {pending ? '수락 중…' : '초대 수락'}
        </Button>
        <Button variant="secondary" onClick={() => router.push('/dashboard')} disabled={pending}>
          취소
        </Button>
      </div>
      {error && <Callout tone="danger">{error}</Callout>}
    </div>
  )
}
