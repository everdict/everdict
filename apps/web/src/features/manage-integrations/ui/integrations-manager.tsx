'use client'

import { useState, useTransition } from 'react'

import type { WorkspaceIntegration } from '@/entities/connection'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label } from '@/shared/ui/input'

import { removeIntegrationAction, setIntegrationAction } from '../api/manage-integrations'

const PROVIDER_LABEL: Record<string, string> = {
  'github-enterprise': 'GitHub Enterprise',
  mattermost: 'Mattermost',
}
const label = (id: string): string => PROVIDER_LABEL[id] ?? id
const hostPlaceholder = (id: string): string =>
  id === 'mattermost' ? 'https://mm.example.com' : 'https://ghe.example.com'

// 관리자용 — self-hosted(GHE/Mattermost) OAuth 앱을 워크스페이스에 1회 등록. 등록 후 멤버는 계정 설정의 "연결된 계정"
// 에서 client ID 입력 없이 원클릭으로 연결한다(Linear 방식). github.com 은 컨트롤플레인 env 로 설정(여기 없음).
export function IntegrationsManager({
  providers,
  callbackUrl,
  canWrite,
}: {
  providers: WorkspaceIntegration[]
  callbackUrl?: string
  canWrite: boolean
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h3 className="text-[13px] font-[560] text-foreground">통합</h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          GitHub Enterprise·Mattermost 서버를 여기에 한 번 등록하면, 멤버는 계정 설정의{' '}
          <span className="font-[510]">연결된 계정</span>에서 버튼 한 번으로 연결할 수 있어요.
          github.com 은 여기서 설정하지 않아요.
        </p>
        {callbackUrl && (
          <p className="text-[12px] leading-relaxed text-faint">
            OAuth 앱에 등록할 콜백 URL 이에요:{' '}
            <span className="font-mono text-muted-foreground">{callbackUrl}</span>
          </p>
        )}
      </div>

      {!canWrite ? (
        <p className="text-[13px] text-muted-foreground">
          통합을 등록하거나 바꾸려면 관리자 권한이 필요해요.
        </p>
      ) : providers.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">설정할 수 있는 서비스가 없어요.</p>
      ) : (
        <div className="space-y-4">
          {providers.map((p) => (
            <IntegrationCard key={p.id} integration={p} />
          ))}
        </div>
      )}
    </div>
  )
}

function IntegrationCard({ integration }: { integration: WorkspaceIntegration }) {
  const [host, setHost] = useState(integration.host ?? '')
  const [clientId, setClientId] = useState(integration.clientId ?? '')
  const [clientSecretName, setClientSecretName] = useState(integration.clientSecretName ?? '')
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [pending, startTransition] = useTransition()

  function onSave() {
    setError(undefined)
    setSaved(false)
    if (!host.trim() || !clientId.trim() || !clientSecretName.trim()) {
      setError('서버 URL · client ID · 시크릿 이름을 모두 입력해주세요.')
      return
    }
    startTransition(async () => {
      const r = await setIntegrationAction(integration.id, {
        host: host.trim(),
        clientId: clientId.trim(),
        clientSecretName: clientSecretName.trim(),
      })
      if (r.ok) setSaved(true)
      else setError(r.error)
    })
  }

  function onRemove() {
    setError(undefined)
    startTransition(async () => {
      const r = await removeIntegrationAction(integration.id)
      setConfirmRemove(false)
      if (r.ok) {
        setHost('')
        setClientId('')
        setClientSecretName('')
      } else setError(r.error)
    })
  }

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4 shadow-raise">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-[560]">{label(integration.id)}</span>
        {integration.configured ? (
          <span className="text-[12px] font-[510] text-[var(--color-success)]">등록됨</span>
        ) : (
          <span className="text-[12px] text-faint">미설정</span>
        )}
      </div>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        {label(integration.id)} 서버에 OAuth 앱을 만들고, client secret 은 먼저 이 워크스페이스의{' '}
        <span className="font-[510]">시크릿</span>에 저장한 뒤 그 이름을 아래에 입력하세요. secret
        값은 직접 입력하지 않아요.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={`int-host-${integration.id}`}>서버 URL (host)</Label>
        <Input
          id={`int-host-${integration.id}`}
          value={host}
          placeholder={hostPlaceholder(integration.id)}
          onChange={(e) => {
            setHost(e.target.value)
            setSaved(false)
          }}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`int-client-id-${integration.id}`}>Client ID</Label>
        <Input
          id={`int-client-id-${integration.id}`}
          value={clientId}
          placeholder="OAuth 앱의 client id (공개값)"
          onChange={(e) => {
            setClientId(e.target.value)
            setSaved(false)
          }}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`int-secret-name-${integration.id}`}>Client secret — 시크릿 이름</Label>
        <Input
          id={`int-secret-name-${integration.id}`}
          value={clientSecretName}
          placeholder="예: GHE_OAUTH_CLIENT_SECRET"
          onChange={(e) => {
            setClientSecretName(e.target.value.toUpperCase())
            setSaved(false)
          }}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="flex items-center gap-3">
        <Button disabled={pending} onClick={onSave}>
          {pending ? '저장 중…' : integration.configured ? '갱신' : '등록'}
        </Button>
        {saved && <span className="text-[13px] text-[var(--color-success)]">저장됨</span>}
        {integration.configured &&
          (confirmRemove ? (
            <span className="flex items-center gap-2">
              <Button variant="destructive" size="sm" disabled={pending} onClick={onRemove}>
                해제 확인
              </Button>
              <button
                type="button"
                className="text-[12px] text-muted-foreground hover:text-foreground"
                onClick={() => setConfirmRemove(false)}
              >
                취소
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="text-[12px] font-[510] text-destructive hover:underline"
              onClick={() => setConfirmRemove(true)}
            >
              통합 해제
            </button>
          ))}
      </div>
      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}
