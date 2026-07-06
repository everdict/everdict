'use client'

import { useState, useTransition } from 'react'

import { SecretPicker } from '@/features/pick-secret'
import type { ImageRegistryConfig } from '@/entities/image-registry'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'

import { removeImageRegistryAction, setImageRegistryAction } from '../api/manage-image-registry'

// 워크스페이스 이미지 레지스트리(BYO) — 관리자가 한 번 등록하면 하니스 이미지의 출처 분류 기준이 되고,
// 멤버는 assay image push 로 로컬 빌드 이미지를 여기로 발행한다. pull/push 토큰 값은 워크스페이스 시크릿
// 참조(이름)로만 저장. 두 피커가 목록을 공유하므로 인라인 생성분은 created 로 합류시킨다.
export function ImageRegistryManager({
  config,
  canWrite,
  secretNames,
}: {
  config?: ImageRegistryConfig
  canWrite: boolean
  secretNames: string[]
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const [missingSecrets, setMissingSecrets] = useState<string[]>()
  const [host, setHost] = useState(config?.host ?? '')
  const [namespace, setNamespace] = useState(config?.namespace ?? '')
  const [username, setUsername] = useState(config?.username ?? '')
  const [pullName, setPullName] = useState(config?.pullSecretName ?? '')
  const [pushName, setPushName] = useState(config?.pushSecretName ?? '')
  const [created, setCreated] = useState<string[]>([])
  const names = [...new Set([...secretNames, ...created])]

  function onSave() {
    setError(undefined)
    setMissingSecrets(undefined)
    if (!host.trim()) {
      setError('레지스트리 호스트를 입력해주세요.')
      return
    }
    startTransition(async () => {
      const r = await setImageRegistryAction({
        host: host.trim(),
        ...(namespace.trim() ? { namespace: namespace.trim() } : {}),
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(pullName.trim() ? { pullSecretName: pullName.trim() } : {}),
        ...(pushName.trim() ? { pushSecretName: pushName.trim() } : {}),
      })
      if (!r.ok) setError(r.error)
      else setMissingSecrets(r.missingSecrets)
    })
  }
  function onRemove() {
    setError(undefined)
    setMissingSecrets(undefined)
    startTransition(async () => {
      const r = await removeImageRegistryAction()
      if (r.ok) {
        setHost('')
        setNamespace('')
        setUsername('')
        setPullName('')
        setPushName('')
      } else setError(r.error)
    })
  }

  const prefix = config?.imagePrefix

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="flex items-center gap-1.5 text-[13px] font-[560] text-foreground">
          이미지 레지스트리
          <InfoTip
            content={
              <>
                팀 이미지 레지스트리(GHCR·Harbor 등)를 등록하면 하니스 이미지가 로컬 빌드인지
                워크스페이스 이미지인지 구분돼요. 멤버는{' '}
                <span className="font-mono">assay image push</span> 로 로컬 빌드 이미지를 여기로
                발행해요. 토큰은 워크스페이스 시크릿에서 고르거나 “새로”로 바로 저장해요 — 여기엔 그
                이름만 남아요.
              </>
            }
          />
        </h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          워크스페이스 단위로 한 번 등록하면 이미지 출처 분류와 발행에 쓰여요.
        </p>
      </div>

      {canWrite ? (
        <div className="space-y-3 rounded-lg border bg-card p-4 shadow-raise">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="reg-host">레지스트리 호스트</Label>
              <Input
                id="reg-host"
                placeholder="ghcr.io · registry.acme.dev:5000"
                value={host}
                onChange={(e) => setHost(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="reg-namespace">네임스페이스 (선택)</Label>
              <Input
                id="reg-namespace"
                placeholder="acme → ghcr.io/acme/<이미지>"
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="reg-username">사용자명 (선택)</Label>
              <Input
                id="reg-username"
                placeholder="docker login 사용자명 — 토큰 단독 레지스트리는 비워둬요"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            {/* pull/push 토큰은 자유 텍스트가 아니라 워크스페이스 시크릿 참조 — 고르거나 인라인 생성. */}
            <div className="space-y-1">
              <Label htmlFor="reg-pull">pull 토큰 시크릿 (선택)</Label>
              <SecretPicker
                id="reg-pull"
                value={pullName}
                onChange={setPullName}
                names={names}
                scope="workspace"
                onCreated={(n) => setCreated((c) => [...c, n])}
                createValuePlaceholder="pull 토큰 붙여넣기"
                aria-label="pull 토큰 시크릿 선택"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="reg-push" className="flex items-center gap-1.5">
                push 토큰 시크릿 (선택)
                <InfoTip
                  content={
                    <>
                      멤버가 <span className="font-mono">assay image push</span> 로 발행할 때 쓰는
                      토큰이에요. 설정하지 않으면 발행은 막히고 분류만 동작해요.
                    </>
                  }
                />
              </Label>
              <SecretPicker
                id="reg-push"
                value={pushName}
                onChange={setPushName}
                names={names}
                scope="workspace"
                onCreated={(n) => setCreated((c) => [...c, n])}
                createValuePlaceholder="push 토큰 붙여넣기"
                aria-label="push 토큰 시크릿 선택"
              />
            </div>
          </div>

          {prefix && (
            <div className="space-y-1 rounded-md border bg-elevated px-3 py-2 text-[12px]">
              <p className="font-[510] text-foreground">발행 대상 프리픽스</p>
              <p className="text-muted-foreground">
                <code className="break-all text-foreground">
                  {prefix}&lt;이미지&gt;:&lt;태그&gt;
                </code>{' '}
                — <code className="break-all">assay image push &lt;로컬 이미지&gt;</code> 가 이
                아래로 발행해요.
              </p>
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button size="sm" disabled={pending} onClick={onSave}>
              {pending ? '저장 중…' : config ? '갱신' : '등록'}
            </Button>
            {config && (
              <button
                type="button"
                className="text-[12px] font-[510] text-destructive hover:underline"
                disabled={pending}
                onClick={onRemove}
              >
                해제
              </button>
            )}
          </div>
        </div>
      ) : config ? (
        <p className="text-[13px] text-muted-foreground">
          {config.imagePrefix} 레지스트리가 등록돼 있어요.
        </p>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          아직 이미지 레지스트리가 등록되지 않았어요.
        </p>
      )}

      {missingSecrets && missingSecrets.length > 0 && (
        <Callout tone="warning" className="py-1.5">
          참조한 시크릿이 아직 없어요: {missingSecrets.join(', ')} — 시크릿 탭에서 저장하면 바로
          동작해요.
        </Callout>
      )}
      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}
