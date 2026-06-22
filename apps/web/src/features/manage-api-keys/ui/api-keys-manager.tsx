'use client'

import { useState, useTransition } from 'react'

import type { ApiKeyMeta } from '@/entities/api-key'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label } from '@/shared/ui/input'

import { createKeyAction, revokeKeyAction } from '../api/manage-api-keys'

export function ApiKeysManager({ keys, canWrite }: { keys: ApiKeyMeta[]; canWrite: boolean }) {
  const [label, setLabel] = useState('')
  const [issued, setIssued] = useState<string>() // 방금 발급된 평문(1회 노출)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string>()
  const [confirmId, setConfirmId] = useState<string>()
  const [pending, startTransition] = useTransition()

  function onCreate() {
    setError(undefined)
    setIssued(undefined)
    setCopied(false)
    startTransition(async () => {
      const r = await createKeyAction(label)
      if (r.ok) {
        setIssued(r.apiKey)
        setLabel('')
      } else {
        setError(r.error)
      }
    })
  }

  function onRevoke(id: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await revokeKeyAction(id)
      setConfirmId(undefined)
      if (!r.ok) setError(r.error)
    })
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold">API 키</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          에이전트·MCP 가 컨트롤플레인에 접근할 때 쓰는 키(<span className="font-mono">ak_…</span>).{' '}
          <span className="font-medium text-foreground">
            발급된 키는 현재 워크스페이스의 admin 권한을 가집니다.
          </span>{' '}
          발급 시 평문은 한 번만 표시되며 이후에는 prefix 로만 식별됩니다.
        </p>
      </div>

      {/* 방금 발급된 키 — 1회 노출 */}
      {issued && (
        <Callout
          tone="warning"
          hint="이 값은 다시 표시되지 않습니다. 지금 복사해 안전한 곳에 보관하세요."
        >
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-xs">{issued}</code>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(issued)
                setCopied(true)
              }}
            >
              {copied ? '복사됨' : '복사'}
            </Button>
          </div>
        </Callout>
      )}

      {/* 목록 */}
      {keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">아직 발급된 키가 없습니다.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <span className="font-mono text-sm">{k.prefix}…</span>
                {k.label && <span className="ml-2 text-sm text-foreground">{k.label}</span>}
                <span className="ml-2 text-xs text-muted-foreground">
                  {new Date(k.createdAt).toLocaleString('ko-KR')}
                </span>
              </div>
              {canWrite &&
                (confirmId === k.id ? (
                  <span className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-destructive/40 text-destructive hover:bg-destructive/5"
                      disabled={pending}
                      onClick={() => onRevoke(k.id)}
                    >
                      취소 확인
                    </Button>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => setConfirmId(undefined)}
                    >
                      닫기
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="text-xs text-destructive hover:underline"
                    onClick={() => setConfirmId(k.id)}
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
        <div className="flex items-end gap-3">
          <div className="flex-1 space-y-1">
            <Label htmlFor="key-label">레이블 (선택)</Label>
            <Input
              id="key-label"
              value={label}
              placeholder="ci-bot, local-dev …"
              onChange={(e) => setLabel(e.target.value)}
              maxLength={80}
            />
          </div>
          <Button onClick={onCreate} disabled={pending}>
            {pending ? '발급 중…' : '새 키 발급'}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          키를 발급/취소하려면 admin 역할(keys:write)이 필요합니다.
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
