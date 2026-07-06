'use client'

import { useState, useTransition } from 'react'

import type { Invite } from '@/entities/member'
import { copyText } from '@/shared/lib/clipboard'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Label } from '@/shared/ui/input'

import { createInviteAction, revokeInviteAction } from '../api/manage-invites'

const ROLES = ['viewer', 'member', 'admin'] as const

function inviteLink(token: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  // 워크스페이스 가입 전 진입점이라 워크스페이스 슬러그가 없는 최상위 라우트.
  return `${origin}/invite?token=${encodeURIComponent(token)}`
}

export function InvitesManager({ invites, canWrite }: { invites: Invite[]; canWrite: boolean }) {
  const [role, setRole] = useState<string>('member')
  const [link, setLink] = useState<string>() // 방금 발급된 초대 링크(1회)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string>()
  const [confirmId, setConfirmId] = useState<string>()
  const [pending, startTransition] = useTransition()

  function onCreate() {
    setError(undefined)
    setLink(undefined)
    setCopied(false)
    startTransition(async () => {
      const r = await createInviteAction(role)
      if (r.ok && r.token) {
        setLink(inviteLink(r.token))
      } else {
        setError(r.error ?? '발급하지 못했어요')
      }
    })
  }

  function onRevoke(id: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await revokeInviteAction(id)
      setConfirmId(undefined)
      if (!r.ok) setError(r.error)
    })
  }

  const pending2 = invites.filter((i) => !i.accepted)

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h3 className="text-[13px] font-[560] text-foreground">초대</h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          초대 링크를 만들어 보내면, 받은 사람이 로그인하고 수락해 이 워크스페이스에 참여해요.
          링크는 <span className="font-[510] text-foreground">한 번만</span> 쓸 수 있어요.
        </p>
      </div>

      {/* 방금 발급된 링크 — 1회 노출 */}
      {link && (
        <Callout tone="warning" hint="이 링크는 한 번만 보여요. 지금 복사해서 전달하세요.">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs">{link}</code>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                void copyText(link).then((ok) => ok && setCopied(true))
              }}
            >
              {copied ? '복사됨' : '링크 복사'}
            </Button>
          </div>
        </Callout>
      )}

      {/* 대기중 초대 목록 */}
      {pending2.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">대기 중인 초대가 없어요.</p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card shadow-raise">
          {pending2.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <span className="font-mono text-[13px]">{i.prefix}…</span>
                <span className="ml-2 text-[12px] text-faint">{i.role}</span>
                <span className="ml-2 text-[12px] text-faint">
                  {i.expiresAt ? `만료 ${new Date(i.expiresAt).toLocaleString('ko-KR')}` : '무기한'}
                </span>
              </div>
              {canWrite &&
                (confirmId === i.id ? (
                  <span className="flex items-center gap-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={pending}
                      onClick={() => onRevoke(i.id)}
                    >
                      취소 확인
                    </Button>
                    <button
                      type="button"
                      className="text-[12px] text-muted-foreground hover:text-foreground"
                      onClick={() => setConfirmId(undefined)}
                    >
                      닫기
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="text-[12px] font-[510] text-destructive hover:underline"
                    onClick={() => setConfirmId(i.id)}
                  >
                    취소
                  </button>
                ))}
            </li>
          ))}
        </ul>
      )}

      {/* 발급 */}
      {canWrite ? (
        <div className="flex items-end gap-2.5">
          <div className="space-y-1.5">
            <Label htmlFor="invite-role">역할</Label>
            <Combobox
              id="invite-role"
              value={role}
              onChange={setRole}
              options={ROLES.map((r) => ({ value: r }))}
              className="w-32"
            />
          </div>
          <Button onClick={onCreate} disabled={pending}>
            {pending ? '발급 중…' : '초대 링크 만들기'}
          </Button>
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          초대를 만들거나 취소하려면 관리자 권한이 필요해요.
        </p>
      )}

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}
