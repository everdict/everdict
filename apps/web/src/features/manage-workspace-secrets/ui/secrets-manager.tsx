'use client'

import { useState, useTransition } from 'react'

import type { SecretMeta } from '@/entities/secret'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { FieldError, Input, Label, Textarea } from '@/shared/ui/input'

import { deleteSecretAction, setSecretAction } from '../api/manage-secrets'

const NAME_RE = /^[A-Z_][A-Z0-9_]*$/

// 두 탭(모델 키 / 클러스터 자격증명)은 같은 워크스페이스 시크릿 네임스페이스를 공유하고, 입력 안내만 다르다.
const COPY = {
  model: {
    title: '모델·프로바이더 키',
    help: 'OPENAI_API_KEY, ANTHROPIC_API_KEY, LiteLLM 키 등. 런 디스패치 시 해당 워크스페이스 잡 env 로만 주입됩니다.',
    namePlaceholder: 'OPENAI_API_KEY',
    multiline: false,
  },
  cluster: {
    title: '클러스터 자격증명',
    help: '런타임 연결용 — NOMAD_TOKEN, K8s bearer 토큰, 또는 전체 kubeconfig(YAML). 컨트롤플레인↔클러스터 API 인증에만 쓰이고 잡(에이전트) env 에는 노출되지 않습니다.',
    namePlaceholder: 'NOMAD_TOKEN',
    multiline: true,
  },
} as const

export function SecretsManager({
  variant,
  secrets,
  canWrite,
}: {
  variant: 'model' | 'cluster'
  secrets: SecretMeta[]
  canWrite: boolean
}) {
  const copy = COPY[variant]
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState<string>()
  const [confirmName, setConfirmName] = useState<string>()
  const [pending, startTransition] = useTransition()

  const nameInvalid = name.length > 0 && !NAME_RE.test(name)

  function onAdd() {
    setError(undefined)
    setSaved(undefined)
    startTransition(async () => {
      const r = await setSecretAction(name, value)
      if (r.ok) {
        setSaved(name)
        setName('')
        setValue('')
      } else {
        setError(r.error)
      }
    })
  }

  function onDelete(target: string) {
    setError(undefined)
    setSaved(undefined)
    startTransition(async () => {
      const r = await deleteSecretAction(target)
      setConfirmName(undefined)
      if (!r.ok) setError(r.error)
    })
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h3 className="text-[13px] font-[560] text-foreground">{copy.title}</h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{copy.help}</p>
        <p className="text-[12px] leading-relaxed text-faint">
          시크릿은 at-rest 암호화되며 값은 다시 표시되지 않습니다(목록은 이름만). 시크릿은
          워크스페이스 단위 단일 네임스페이스이며, 두 탭은 입력 안내만 다릅니다.
        </p>
      </div>

      {secrets.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">아직 등록된 시크릿이 없습니다.</p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card shadow-raise">
          {secrets.map((s) => (
            <li key={s.name} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <span className="font-mono text-[13px]">{s.name}</span>
                <span className="ml-2 text-[12px] text-faint">
                  {new Date(s.updatedAt).toLocaleString('ko-KR')}
                </span>
              </div>
              {canWrite &&
                (confirmName === s.name ? (
                  <span className="flex items-center gap-2">
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={pending}
                      onClick={() => onDelete(s.name)}
                    >
                      삭제 확인
                    </Button>
                    <button
                      type="button"
                      className="text-[12px] text-muted-foreground hover:text-foreground"
                      onClick={() => setConfirmName(undefined)}
                    >
                      취소
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="text-[12px] font-[510] text-destructive hover:underline"
                    onClick={() => setConfirmName(s.name)}
                  >
                    삭제
                  </button>
                ))}
            </li>
          ))}
        </ul>
      )}

      {canWrite ? (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
          <div className="space-y-1.5">
            <Label htmlFor={`secret-name-${variant}`}>이름 (env 형식)</Label>
            <Input
              id={`secret-name-${variant}`}
              value={name}
              placeholder={copy.namePlaceholder}
              onChange={(e) => {
                setName(e.target.value.toUpperCase())
                setSaved(undefined)
              }}
              autoComplete="off"
              spellCheck={false}
            />
            {nameInvalid && <FieldError message="^[A-Z_][A-Z0-9_]*$ 형식이어야 합니다." />}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`secret-value-${variant}`}>값</Label>
            {copy.multiline ? (
              <Textarea
                id={`secret-value-${variant}`}
                value={value}
                placeholder="토큰 또는 kubeconfig YAML 붙여넣기"
                onChange={(e) => setValue(e.target.value)}
                rows={6}
                spellCheck={false}
              />
            ) : (
              <Input
                id={`secret-value-${variant}`}
                type="password"
                value={value}
                placeholder="시크릿 값"
                onChange={(e) => setValue(e.target.value)}
                autoComplete="off"
              />
            )}
            <p className="text-[12px] text-faint">
              기존 이름으로 저장하면 값이 교체됩니다. 저장 후에는 값을 다시 볼 수 없습니다.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              onClick={onAdd}
              disabled={pending || name.length === 0 || value.length === 0 || nameInvalid}
            >
              {pending ? '저장 중…' : '저장'}
            </Button>
            {saved && (
              <span className="text-[13px] text-[var(--color-success)]">저장됨: {saved}</span>
            )}
          </div>
          {error && (
            <Callout tone="danger" className="py-1.5">
              {error}
            </Callout>
          )}
        </div>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          변경하려면 admin 역할(secrets:write)이 필요합니다.
        </p>
      )}
    </div>
  )
}
