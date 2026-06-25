'use client'

import { useState, useTransition } from 'react'

import type { ConnectionMeta, ProviderInfo } from '@/entities/connection'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'

import { disconnectConnectionAction, startConnectionAction } from '../api/manage-connections'

// provider id → 표시 이름.
const PROVIDER_LABEL: Record<string, string> = {
  github: 'GitHub',
  'github-enterprise': 'GitHub Enterprise',
  mattermost: 'Mattermost',
}
const label = (id: string): string => PROVIDER_LABEL[id] ?? id

// 콜백 리다이렉트로 돌아온 결과(?connected=… / ?error=…) → 사람이 읽는 메시지.
const ERROR_COPY: Record<string, string> = {
  invalid_state: '연결 세션이 만료되었거나 유효하지 않습니다. 다시 시도해 주세요.',
  missing_state: '연결 세션 정보가 없습니다. 다시 시도해 주세요.',
  missing_code: 'provider 가 인증 코드를 돌려주지 않았습니다.',
  unknown_provider: '알 수 없는 provider 입니다.',
  exchange_failed:
    '토큰 교환에 실패했습니다. provider 설정(콜백 URL/scope/시크릿)을 확인해 주세요.',
  access_denied: '연결이 취소되었습니다(권한 거부).',
}

// 연결은 개인 소유(self-scoped by subject) — 역할 게이트 없음. 멤버는 자격증명 입력 없이 원클릭으로 연결한다(Linear 방식):
// github.com 은 컨트롤플레인 env OAuth 앱, self-hosted(GHE/Mattermost)는 관리자가 워크스페이스 통합을 등록한 경우에만 노출.
export function ConnectionsManager({
  connections,
  providers,
  connected,
  error,
}: {
  connections: ConnectionMeta[]
  providers: ProviderInfo[]
  connected?: string // ?connected=<provider> — 방금 연결 성공
  error?: string // ?error=<reason> — 콜백 실패
}) {
  const [actionError, setActionError] = useState<string>()
  const [confirmId, setConfirmId] = useState<string>()
  const [pending, startTransition] = useTransition()

  // 연결 시작 → authorizeUrl 로 이동(멤버는 자격증명 입력 없음).
  function onConnect(provider: string) {
    setActionError(undefined)
    startTransition(async () => {
      const r = await startConnectionAction(provider)
      if (r.ok && r.authorizeUrl) window.location.href = r.authorizeUrl
      else setActionError(r.error ?? '연결을 시작하지 못했습니다.')
    })
  }

  function onDisconnect(id: string) {
    setActionError(undefined)
    startTransition(async () => {
      const r = await disconnectConnectionAction(id)
      setConfirmId(undefined)
      if (!r.ok) setActionError(r.error)
    })
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h3 className="text-[13px] font-[560] text-foreground">연결된 계정</h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          GitHub 등 외부 계정을 OAuth 로 연결합니다. 이 연결은 워크스페이스가 아닌 내 계정 소유로,
          내가 속한 어느 워크스페이스에서든 보입니다. 토큰은 내 run 의 비공개 repo 클론·이미지
          풀·결과 게시·알림에 사용되며 at-rest 암호화됩니다(값은 다시 표시되지 않습니다).
        </p>
      </div>

      {connected && (
        <div className="rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success)]/8 px-3.5 py-1.5 text-[13px] text-[var(--color-success)]">
          {label(connected)} 계정을 연결했습니다.
        </div>
      )}
      {error && (
        <Callout tone="danger" className="py-1.5">
          {ERROR_COPY[error] ?? `연결 실패: ${error}`}
        </Callout>
      )}

      {connections.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">아직 연결된 계정이 없습니다.</p>
      ) : (
        <ul className="divide-y rounded-lg border bg-card shadow-raise">
          {connections.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <span className="text-[13px] font-[560]">{label(c.provider)}</span>
                <span className="ml-2 font-mono text-[13px] text-muted-foreground">
                  {c.accountLabel}
                </span>
                {c.host && <span className="ml-2 text-[12px] text-faint">{c.host}</span>}
                <div className="mt-0.5 text-[12px] text-faint">
                  {c.scopes.length > 0 && (
                    <span className="font-mono">{c.scopes.join(' ')} · </span>
                  )}
                  {new Date(c.connectedAt).toLocaleString('ko-KR')}
                </div>
              </div>
              {confirmId === c.id ? (
                <span className="flex items-center gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={pending}
                    onClick={() => onDisconnect(c.id)}
                  >
                    해제 확인
                  </Button>
                  <button
                    type="button"
                    className="text-[12px] text-muted-foreground hover:text-foreground"
                    onClick={() => setConfirmId(undefined)}
                  >
                    취소
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="text-[12px] font-[510] text-destructive hover:underline"
                  onClick={() => setConfirmId(c.id)}
                >
                  연결 해제
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {providers.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">
          연결 가능한 provider 가 없습니다 — github.com 원클릭은 관리자가 컨트롤플레인에 OAuth
          앱(GITHUB_OAUTH_CLIENT_ID/SECRET)을, GitHub Enterprise·Mattermost 는 관리자가 워크스페이스
          설정의 <span className="font-[510]">통합</span> 탭에서 OAuth 앱을 등록해야 합니다.
        </p>
      ) : (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-4">
          <p className="text-[13px] font-[510] text-foreground">새 계정 연결</p>
          <div className="flex flex-wrap items-center gap-2">
            {providers.map((p) => (
              <Button key={p.id} variant="secondary" disabled={pending} onClick={() => onConnect(p.id)}>
                {label(p.id)} 연결
              </Button>
            ))}
          </div>
          <p className="text-[12px] text-faint">
            연결 버튼을 누르면 provider 로그인 화면으로 이동한 뒤 이 페이지로 돌아옵니다.
          </p>
          {actionError && (
            <Callout tone="danger" className="py-1.5">
              {actionError}
            </Callout>
          )}
        </div>
      )}
    </div>
  )
}
