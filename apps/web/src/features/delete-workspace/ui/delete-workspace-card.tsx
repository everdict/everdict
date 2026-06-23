'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2 } from 'lucide-react'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label } from '@/shared/ui/input'

import { deleteWorkspaceAction } from '../api/delete-workspace'

// 위험 구역 — 워크스페이스 영구 삭제(되돌릴 수 없음). owner 에게만 렌더된다(상위에서 isOwner 게이트).
// 이름을 정확히 입력해야 삭제 버튼이 활성(실수 방지). 성공 시 홈(/)으로 보내 남은 워크스페이스/온보딩으로 재라우팅.
export function DeleteWorkspaceCard({ workspaceName }: { workspaceName: string }) {
  const router = useRouter()
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, startTransition] = useTransition()
  const match = confirm.trim() === workspaceName

  function onDelete() {
    if (!match) return
    setError(undefined)
    startTransition(async () => {
      const r = await deleteWorkspaceAction()
      if (r.ok) {
        router.push('/')
        router.refresh()
      } else {
        setError(r.error ?? '삭제에 실패했습니다.')
      }
    })
  }

  return (
    <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/[0.03] p-4">
      <div className="space-y-1">
        <h3 className="text-[13px] font-[560] text-foreground">워크스페이스 삭제</h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          <span className="font-[510] text-foreground">{workspaceName}</span> 와(과) 그 모든
          데이터(런·데이터셋·하네스·멤버·시크릿 등)를 영구히 삭제합니다. 이 작업은 되돌릴 수
          없습니다.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ws-delete-confirm">
          계속하려면 <span className="font-mono text-foreground">{workspaceName}</span> 을(를)
          입력하세요.
        </Label>
        <Input
          id="ws-delete-confirm"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={workspaceName}
          autoComplete="off"
        />
      </div>
      {error && <Callout tone="danger">{error}</Callout>}
      <Button
        variant="destructive"
        onClick={onDelete}
        disabled={!match || pending}
        className="gap-1.5"
      >
        <Trash2 className="size-4" />
        {pending ? '삭제 중…' : '워크스페이스 영구 삭제'}
      </Button>
    </div>
  )
}
