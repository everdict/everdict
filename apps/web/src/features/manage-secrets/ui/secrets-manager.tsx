'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import type { SecretMeta } from '@/entities/secret'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label } from '@/shared/ui/input'

import { deleteSecretAction, setSecretAction } from '../api/manage-secrets'

// 워크스페이스 시크릿 관리 — 이름 목록(값은 write-only, 절대 표시 안 함) + 추가/덮어쓰기/삭제.
// 모델 키(ANTHROPIC_API_KEY/OPENAI_API_KEY)와 클러스터 토큰(NOMAD_TOKEN 등)이 모두 여기 산다.
export function SecretsManager({ secrets, canWrite }: { secrets: SecretMeta[]; canWrite: boolean }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  function onSave() {
    setError(undefined)
    startTransition(async () => {
      const res = await setSecretAction(name, value)
      if (res.ok) {
        setName('')
        setValue('')
        router.refresh()
      } else setError(res.error ?? '저장 실패')
    })
  }

  function onDelete(secretName: string) {
    setError(undefined)
    startTransition(async () => {
      const res = await deleteSecretAction(secretName)
      if (res.ok) router.refresh()
      else setError(res.error ?? '삭제 실패')
    })
  }

  return (
    <div className="space-y-6">
      {/* 기존 시크릿 목록 — 이름 + 갱신시각만(값 없음) */}
      <div className="space-y-2">
        {secrets.length === 0 ? (
          <Callout tone="muted">등록된 시크릿이 없습니다.</Callout>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {secrets.map((s) => (
              <li key={s.name} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <code className="font-mono text-sm">{s.name}</code>
                  <p className="text-xs text-muted-foreground">갱신 {s.updatedAt}</p>
                </div>
                {canWrite && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => onDelete(s.name)}
                  >
                    삭제
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 추가/덮어쓰기 폼 — 같은 이름이면 덮어쓴다 */}
      {canWrite && (
        <div className="space-y-4 rounded-lg border border-border p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="secret-name">이름</Label>
              <Input
                id="secret-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="NOMAD_TOKEN"
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="secret-value">값</Label>
              <Input
                id="secret-value"
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="••••••••"
                autoComplete="off"
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            값은 at-rest 암호화되어 저장되며 다시 표시되지 않습니다. 같은 이름으로 저장하면
            덮어씁니다. 실행 시점에만 복호화되어 그 워크스페이스의 잡 env 로 주입됩니다.
          </p>
          {error && <Callout tone="danger">{error}</Callout>}
          <Button type="button" onClick={onSave} disabled={pending || !name.trim() || !value}>
            {pending ? '저장 중…' : '시크릿 저장'}
          </Button>
        </div>
      )}
      {!canWrite && error && <Callout tone="danger">{error}</Callout>}
    </div>
  )
}
