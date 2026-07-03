'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Trash2 } from 'lucide-react'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label } from '@/shared/ui/input'

import { deleteWorkspaceAction } from '../api/delete-workspace'

// 위험 구역 — owner 에게만 렌더된다(상위에서 isOwner 게이트). 카드에는 삭제 버튼만 노출하고, 누르면 팝업에서
// 워크스페이스 이름을 정확히 입력해야 삭제가 활성(실수 방지). 성공 시 홈(/)으로 보내 남은 워크스페이스/온보딩으로 재라우팅.
export function DeleteWorkspaceCard({ workspaceName }: { workspaceName: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [pending, startTransition] = useTransition()
  const match = confirm.trim() === workspaceName

  function close() {
    if (pending) return
    setOpen(false)
    setConfirm('')
    setError(undefined)
  }

  function onDelete() {
    if (!match) return
    setError(undefined)
    startTransition(async () => {
      const r = await deleteWorkspaceAction()
      if (r.ok) {
        router.push('/')
        router.refresh()
      } else {
        setError(r.error ?? '삭제하지 못했어요.')
      }
    })
  }

  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-destructive/30 bg-destructive/[0.03] p-4">
      <div className="space-y-1">
        <h3 className="text-[13px] font-[560] text-foreground">워크스페이스 삭제</h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          워크스페이스와 모든 데이터가 사라져요. 되돌릴 수 없어요.
        </p>
      </div>
      <Button variant="destructive" onClick={() => setOpen(true)} className="shrink-0 gap-1.5">
        <Trash2 className="size-4" />
        워크스페이스 삭제
      </Button>

      <Dialog open={open} onClose={close} className="max-w-md" labelledBy="ws-delete-title">
        <div className="space-y-4 p-5">
          <div className="space-y-1.5">
            <h2 id="ws-delete-title" className="text-[15px] font-[560] text-foreground">
              워크스페이스 삭제
            </h2>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              <span className="font-[510] text-foreground">{workspaceName}</span> 와(과) 모든
              런·데이터셋·하네스·멤버·시크릿이 영구히 삭제돼요. 되돌릴 수 없어요.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ws-delete-confirm">
              계속하려면 <span className="font-mono text-foreground">{workspaceName}</span> 을(를)
              입력해주세요.
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
          <div className="flex items-center justify-end gap-2.5 pt-1">
            <Button variant="secondary" onClick={close} disabled={pending}>
              취소
            </Button>
            <Button
              variant="destructive"
              onClick={onDelete}
              disabled={!match || pending}
              className="gap-1.5"
            >
              <Trash2 className="size-4" />
              {pending ? '삭제 중…' : '영구 삭제'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
