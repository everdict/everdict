'use client'

import { useState, useTransition } from 'react'

import type { ApiKeyMeta, ApiKeyScope } from '@/entities/api-key'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label } from '@/shared/ui/input'

import { createKeyAction, revokeKeyAction } from '../api/manage-api-keys'

// scopes 미지정/admin = Full Access. 그 외는 선택 권한을 사람이 읽는 라벨로.
function scopeLabel(scopes?: ApiKeyScope[]): string {
  if (!scopes || scopes.length === 0 || scopes.includes('admin')) return 'Full Access'
  return scopes.map((s) => (s === 'read' ? 'Read' : 'Write')).join(' · ')
}

export function ApiKeysManager({ keys, canWrite }: { keys: ApiKeyMeta[]; canWrite: boolean }) {
  const [label, setLabel] = useState('')
  const [mode, setMode] = useState<'full' | 'custom'>('full') // 전체 액세스 vs 범위 지정
  const [scopeRead, setScopeRead] = useState(true)
  const [scopeWrite, setScopeWrite] = useState(false)
  const [issued, setIssued] = useState<string>() // 방금 발급된 평문(1회 노출)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string>()
  const [confirmId, setConfirmId] = useState<string>()
  const [pending, startTransition] = useTransition()

  function onCreate() {
    setError(undefined)
    setIssued(undefined)
    setCopied(false)
    // 범위 지정이면 선택한 scope 만, 전체 액세스면 미지정(=서버에서 Full Access).
    let scopes: ApiKeyScope[] | undefined
    if (mode === 'custom') {
      scopes = []
      if (scopeRead) scopes.push('read')
      if (scopeWrite) scopes.push('write')
      if (scopes.length === 0) {
        setError('권한을 하나 이상 선택하세요.')
        return
      }
    }
    startTransition(async () => {
      const r = await createKeyAction(label, scopes)
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
      <div className="space-y-1">
        <h3 className="text-[13px] font-[560] text-foreground">API 키</h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          에이전트·MCP 가 컨트롤플레인에 접근할 때 쓰는 키(<span className="font-mono">ak_…</span>).{' '}
          <span className="font-[510] text-foreground">
            발급 시 권한(Full Access 또는 선택 범위)을 정할 수 있습니다.
          </span>{' '}
          평문은 한 번만 표시되며 이후에는 prefix 로만 식별됩니다.
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
        <p className="text-[13px] text-muted-foreground">아직 발급된 키가 없습니다.</p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card shadow-raise">
          {keys.map((k) => (
            <li key={k.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <span className="font-mono text-[13px]">{k.prefix}…</span>
                {k.label && (
                  <span className="ml-2 text-[13px] font-[510] text-foreground">{k.label}</span>
                )}
                <Badge tone="outline" className="ml-2 align-middle">
                  {scopeLabel(k.scopes)}
                </Badge>
                <span className="ml-2 text-[12px] text-faint">
                  {new Date(k.createdAt).toLocaleString('ko-KR')}
                </span>
              </div>
              {canWrite &&
                (confirmId === k.id ? (
                  <span className="flex items-center gap-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={pending}
                      onClick={() => onRevoke(k.id)}
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
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="key-label">레이블 (선택)</Label>
            <Input
              id="key-label"
              value={label}
              placeholder="ci-bot, local-dev …"
              onChange={(e) => setLabel(e.target.value)}
              maxLength={80}
            />
          </div>

          <div className="space-y-2">
            <Label>권한 (Permissions)</Label>
            <div className="space-y-2 rounded-lg border bg-card p-3">
              <label className="flex items-start gap-2.5 text-[13px]">
                <input
                  type="radio"
                  name="key-access"
                  className="mt-0.5 accent-primary"
                  checked={mode === 'full'}
                  onChange={() => setMode('full')}
                />
                <span>
                  <span className="font-[510] text-foreground">전체 액세스 (Full Access)</span>
                  <span className="block text-[12px] text-muted-foreground">
                    워크스페이스 admin 권한 — 모든 작업 가능.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 text-[13px]">
                <input
                  type="radio"
                  name="key-access"
                  className="mt-0.5 accent-primary"
                  checked={mode === 'custom'}
                  onChange={() => setMode('custom')}
                />
                <span>
                  <span className="font-[510] text-foreground">범위 지정 (Custom)</span>
                  <span className="block text-[12px] text-muted-foreground">선택한 권한만 부여.</span>
                </span>
              </label>
              {mode === 'custom' && (
                <div className="ml-6 space-y-1.5 border-l pl-3">
                  <label className="flex items-start gap-2 text-[13px]">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-primary"
                      checked={scopeRead}
                      onChange={(e) => setScopeRead(e.target.checked)}
                    />
                    <span>
                      <span className="font-[510] text-foreground">읽기 (Read)</span>
                      <span className="block text-[12px] text-muted-foreground">
                        워크스페이스 데이터 조회.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-[13px]">
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-primary"
                      checked={scopeWrite}
                      onChange={(e) => setScopeWrite(e.target.checked)}
                    />
                    <span>
                      <span className="font-[510] text-foreground">쓰기 (Write)</span>
                      <span className="block text-[12px] text-muted-foreground">
                        run 제출·등록·버전 생성·실행 (읽기 포함). secrets·멤버 등 거버넌스는 제외.
                      </span>
                    </span>
                  </label>
                </div>
              )}
            </div>
          </div>

          <Button onClick={onCreate} disabled={pending}>
            {pending ? '발급 중…' : '새 키 발급'}
          </Button>
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">
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
