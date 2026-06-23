'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { LogOut } from 'lucide-react'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'

import { leaveWorkspaceAction } from '../api/leave-workspace'

// 이 워크스페이스에서 나가기 — 2단계 확인(잘못 누름 방지). 성공 시 홈(/)으로 보내 남은 워크스페이스/온보딩으로 재라우팅.
// 마지막 admin 은 컨트롤플레인이 409 로 막고, 그 메시지를 인라인으로 보여준다.
export function LeaveWorkspaceButton({ workspaceName }: { workspaceName: string }) {
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
    <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/[0.03] p-4">
      <div className="space-y-1">
        <h3 className="text-[13px] font-[560] text-foreground">워크스페이스 나가기</h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          <span className="font-[510] text-foreground">{workspaceName}</span> 에서 내 멤버십을 제거합니다. 이
          워크스페이스의 데이터는 더 이상 보이지 않습니다(마지막 admin 은 나갈 수 없습니다).
        </p>
      </div>
      {error && <Callout tone="danger">{error}</Callout>}
      {confirming ? (
        <div className="flex items-center gap-2.5">
          <Button variant="destructive" onClick={onLeave} disabled={pending}>
            {pending ? '나가는 중…' : '정말 나가기'}
          </Button>
          <button
            type="button"
            className="text-[12px] text-muted-foreground hover:text-foreground"
            onClick={() => setConfirming(false)}
            disabled={pending}
          >
            취소
          </button>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setConfirming(true)} className="gap-1.5">
          <LogOut className="size-4" />이 워크스페이스에서 나가기
        </Button>
      )}
    </div>
  )
}
