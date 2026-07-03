'use client'

import { useState, useTransition } from 'react'

import type { Member } from '@/entities/member'
import { Avatar } from '@/shared/ui/avatar'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'

import { removeMemberAction, setMemberRoleAction } from '../api/manage-members'

const ROLES = ['viewer', 'member', 'admin'] as const

// 표시용 신원 — opaque subject 는 마지막 폴백일 뿐, 가능하면 이름>이메일 순으로 보여준다.
function memberLabel(m: Member): string {
  return m.name ?? m.email ?? m.subject
}

export function MembersManager({ members, canWrite }: { members: Member[]; canWrite: boolean }) {
  const [error, setError] = useState<string>()
  const [confirmSubject, setConfirmSubject] = useState<string>()
  const [pending, startTransition] = useTransition()

  function onRole(subject: string, role: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await setMemberRoleAction(subject, role)
      if (!r.ok) setError(r.error)
    })
  }

  function onRemove(subject: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await removeMemberAction(subject)
      setConfirmSubject(undefined)
      if (!r.ok) setError(r.error)
    })
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-[13px] font-[560] text-foreground">
          사람
          <span className="text-[12px] font-normal text-faint">{members.length}</span>
        </h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          이 워크스페이스에 참여한 사람들이에요. 역할 변경과 제거는 관리자만 할 수 있고, 마지막
          관리자는 내보내거나 강등할 수 없어요. 새 멤버는 초대 링크로 추가하세요.
        </p>
      </div>

      {members.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">멤버가 없어요.</p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card shadow-raise">
          {members.map((m) => (
            <li key={m.subject} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <Avatar
                  name={memberLabel(m)}
                  size="lg"
                  {...(m.avatarUrl ? { url: m.avatarUrl } : {})}
                />
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-[510] text-foreground">
                    {memberLabel(m)}
                  </div>
                  {m.name && m.email && (
                    <div className="truncate text-[12px] text-muted-foreground">{m.email}</div>
                  )}
                </div>
              </div>
              {canWrite ? (
                <span className="flex items-center gap-2">
                  <Combobox
                    value={m.role}
                    disabled={pending}
                    onChange={(v) => onRole(m.subject, v)}
                    options={ROLES.map((r) => ({ value: r }))}
                    className="w-28"
                    aria-label="역할"
                  />
                  {confirmSubject === m.subject ? (
                    <>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={pending}
                        onClick={() => onRemove(m.subject)}
                      >
                        제거 확인
                      </Button>
                      <button
                        type="button"
                        className="text-[12px] text-muted-foreground hover:text-foreground"
                        onClick={() => setConfirmSubject(undefined)}
                      >
                        닫기
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="text-[12px] font-[510] text-destructive hover:underline"
                      onClick={() => setConfirmSubject(m.subject)}
                    >
                      제거
                    </button>
                  )}
                </span>
              ) : (
                <span className="text-[12px] text-muted-foreground">{m.role}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}
