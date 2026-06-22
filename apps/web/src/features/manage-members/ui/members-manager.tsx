'use client'

import { useState, useTransition } from 'react'

import type { Member } from '@/entities/member'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Select } from '@/shared/ui/input'

import { removeMemberAction, setMemberRoleAction } from '../api/manage-members'

const ROLES = ['viewer', 'member', 'admin'] as const

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
      <div>
        <h3 className="text-sm font-semibold">멤버</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          이 워크스페이스의 멤버와 역할. 역할 변경·제거는 admin 전용이며, 마지막 admin 은
          강등/제거할 수 없습니다. 새 멤버는 아래 초대 링크로 추가합니다.
        </p>
      </div>

      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">멤버가 없습니다.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {members.map((m) => (
            <li key={m.subject} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <span className="text-sm font-medium">{m.email ?? m.subject}</span>
                {m.email && (
                  <span className="ml-2 truncate font-mono text-xs text-muted-foreground">
                    {m.subject}
                  </span>
                )}
                <span className="ml-2 text-xs text-muted-foreground">
                  {new Date(m.addedAt).toLocaleDateString('ko-KR')}
                </span>
              </div>
              {canWrite ? (
                <span className="flex items-center gap-2">
                  <Select
                    value={m.role}
                    disabled={pending}
                    onChange={(e) => onRole(m.subject, e.target.value)}
                    className="h-8 w-28 py-0 text-xs"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </Select>
                  {confirmSubject === m.subject ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-destructive/40 text-destructive hover:bg-destructive/5"
                        disabled={pending}
                        onClick={() => onRemove(m.subject)}
                      >
                        제거 확인
                      </Button>
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => setConfirmSubject(undefined)}
                      >
                        닫기
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="text-xs text-destructive hover:underline"
                      onClick={() => setConfirmSubject(m.subject)}
                    >
                      제거
                    </button>
                  )}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">{m.role}</span>
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
