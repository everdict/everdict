'use client'

import { useState, useTransition } from 'react'

import { SecretPicker } from '@/features/pick-secret'
import type { ImageRegistryConfig } from '@/entities/image-registry'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import { removeImageRegistryAction, upsertImageRegistryAction } from '../api/manage-image-registry'

// 워크스페이스 이미지 레지스트리(BYO, 복수) — 관리자가 등록하면 하니스 이미지의 출처 분류 기준이 되고,
// 멤버는 assay image push 로 로컬 빌드 이미지를 여기로 발행한다(여러 개면 --registry <이름> 으로 선택).
// pull/push 토큰 값은 워크스페이스 시크릿 참조(이름)로만 저장. 두 피커가 목록을 공유하므로 인라인
// 생성분은 created 로 합류시킨다.
export function ImageRegistryManager({
  registries,
  canWrite,
  secretNames,
}: {
  registries: ImageRegistryConfig[]
  canWrite: boolean
  secretNames: string[]
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const [missingSecrets, setMissingSecrets] = useState<string[]>()
  // 편집 대상 name — 행 클릭으로 폼에 프리필(저장은 name 기준 upsert). undefined = 새 레지스트리 추가.
  const [editing, setEditing] = useState<string>()
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [namespace, setNamespace] = useState('')
  const [username, setUsername] = useState('')
  const [pullName, setPullName] = useState('')
  const [pushName, setPushName] = useState('')
  const [created, setCreated] = useState<string[]>([])
  const names = [...new Set([...secretNames, ...created])]

  function resetForm() {
    setEditing(undefined)
    setName('')
    setHost('')
    setNamespace('')
    setUsername('')
    setPullName('')
    setPushName('')
  }

  function startEdit(r: ImageRegistryConfig) {
    setError(undefined)
    setMissingSecrets(undefined)
    setEditing(r.name)
    setName(r.name)
    setHost(r.host)
    setNamespace(r.namespace ?? '')
    setUsername(r.username ?? '')
    setPullName(r.pullSecretName ?? '')
    setPushName(r.pushSecretName ?? '')
  }

  function onSave() {
    setError(undefined)
    setMissingSecrets(undefined)
    if (!name.trim()) {
      setError('레지스트리 이름을 입력해주세요.')
      return
    }
    if (!host.trim()) {
      setError('레지스트리 호스트를 입력해주세요.')
      return
    }
    startTransition(async () => {
      const r = await upsertImageRegistryAction({
        name: name.trim(),
        host: host.trim(),
        ...(namespace.trim() ? { namespace: namespace.trim() } : {}),
        ...(username.trim() ? { username: username.trim() } : {}),
        ...(pullName.trim() ? { pullSecretName: pullName.trim() } : {}),
        ...(pushName.trim() ? { pushSecretName: pushName.trim() } : {}),
      })
      if (!r.ok) setError(r.error)
      else {
        setMissingSecrets(r.missingSecrets)
        resetForm()
      }
    })
  }

  function onRemove(target: string) {
    setError(undefined)
    setMissingSecrets(undefined)
    startTransition(async () => {
      const r = await removeImageRegistryAction(target)
      if (!r.ok) setError(r.error)
      else if (editing === target) resetForm()
    })
  }

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
                발행해요 — 여러 개면 <span className="font-mono">--registry &lt;이름&gt;</span> 으로
                고르고, 1개뿐이면 생략해도 돼요. 토큰은 워크스페이스 시크릿에서 고르거나 “새로”로
                바로 저장해요 — 여기엔 그 이름만 남아요.
              </>
            }
          />
        </h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          워크스페이스 단위로 등록하면 이미지 출처 분류와 발행에 쓰여요.
        </p>
      </div>

      {registries.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">아직 등록된 이미지 레지스트리가 없어요.</p>
      ) : (
        <SettingsList>
          {registries.map((r) => (
            <SettingsRow
              key={r.name}
              label={
                <span className="inline-flex items-center gap-1.5">
                  {r.name}
                  <code className="rounded border border-border bg-muted/40 px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">
                    {r.host}
                    {r.namespace ? `/${r.namespace}` : ''}
                  </code>
                </span>
              }
              hint={
                <span className="break-all font-mono text-[11.5px]">
                  {r.imagePrefix}&lt;이미지&gt;:&lt;태그&gt;
                </span>
              }
            >
              {canWrite && (
                <>
                  <button
                    type="button"
                    className="text-[12px] font-[510] text-link hover:text-foreground"
                    disabled={pending}
                    onClick={() => startEdit(r)}
                  >
                    편집
                  </button>
                  <button
                    type="button"
                    className="text-[12px] font-[510] text-destructive hover:underline"
                    disabled={pending}
                    onClick={() => onRemove(r.name)}
                  >
                    삭제
                  </button>
                </>
              )}
            </SettingsRow>
          ))}
        </SettingsList>
      )}

      {registries.length > 0 && (
        <div className="space-y-1 rounded-md border bg-elevated px-3 py-2 text-[12px]">
          <p className="font-[510] text-foreground">발행(push) 방법</p>
          <p className="text-muted-foreground">
            <code className="break-all text-foreground">
              assay image push &lt;로컬 이미지&gt; --registry &lt;이름&gt;
            </code>{' '}
            — 그 레지스트리의 프리픽스 아래로 발행해요. 레지스트리가 1개뿐이면{' '}
            <code className="break-all">--registry</code> 는 생략 가능해요.
          </p>
        </div>
      )}

      {canWrite && (
        <div className="space-y-3 rounded-lg border bg-card p-4 shadow-raise">
          <p className="text-[12px] font-[560] text-foreground">
            {editing ? `${editing} 수정` : '새 레지스트리 추가'}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="reg-name">이름</Label>
              {/* 이름 = upsert 키 — 편집 중엔 잠가서 의도치 않은 별도 레지스트리 생성(rename≠upsert)을 막는다. */}
              <Input
                id="reg-name"
                placeholder="예: team-ghcr"
                value={name}
                disabled={editing !== undefined}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
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

          <div className="flex items-center gap-3">
            <Button size="sm" disabled={pending} onClick={onSave}>
              {pending ? '저장 중…' : editing ? '갱신' : '등록'}
            </Button>
            {editing && (
              <button
                type="button"
                className="text-[12px] text-muted-foreground hover:text-foreground"
                disabled={pending}
                onClick={resetForm}
              >
                취소
              </button>
            )}
          </div>
        </div>
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
