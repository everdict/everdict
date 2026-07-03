'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'

import type { ConnectionMeta, ProviderInfo } from '@/entities/connection'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'

import { disconnectConnectionAction, startConnectionAction } from '../api/manage-connections'

// provider id → 표시 이름 + 한 줄 설명(카탈로그 행 hint).
const PROVIDER_LABEL: Record<string, string> = {
  github: 'GitHub',
  'github-enterprise': 'GitHub Enterprise',
  mattermost: 'Mattermost',
}
const PROVIDER_DESC: Record<string, string> = {
  github: 'github.com 계정 — 비공개 저장소 가져오기·결과 게시',
  'github-enterprise': '직접 운영하는 GitHub Enterprise',
  mattermost: '실행·스코어카드가 끝나면 Mattermost 로 알려요',
}
const label = (id: string): string => PROVIDER_LABEL[id] ?? id

// 콜백 리다이렉트로 돌아온 결과(?connected=… / ?error=…) → 사람이 읽는 메시지.
const ERROR_COPY: Record<string, string> = {
  invalid_state: '연결 시간이 지났어요. 다시 시도해주세요.',
  missing_state: '연결 정보가 없어요. 다시 시도해주세요.',
  missing_code: '인증 코드를 받지 못했어요.',
  unknown_provider: '알 수 없는 서비스예요.',
  exchange_failed: '연결에 실패했어요. 서비스 설정을 확인해주세요.',
  access_denied: '연결을 취소했어요.',
}

// 연결은 개인 소유(self-scoped by subject) — 역할 게이트 없음. 공식 지원 3종을 항상 카탈로그로 노출하고 각각 Connect 버튼을
// 둔다(Linear 방식). connectable 이면 바로 원클릭(github.com=env OAuth 앱, self-hosted=관리자 통합 등록). 설정 안 된 provider 는
// Connect 대신 설정 안내: self-hosted 는 관리자에게 통합 설정 딥링크 / 멤버에게 "관리자 설정 필요", github.com 은 env 안내.
export function ConnectionsManager({
  connections,
  providers,
  workspace,
  canManageIntegrations,
  connected,
  error,
}: {
  connections: ConnectionMeta[]
  providers: ProviderInfo[]
  workspace: string // 활성 워크스페이스 슬러그 — self-hosted 통합 설정 딥링크용(/{workspace}/settings?tab=integrations)
  canManageIntegrations: boolean // settings:write — true 면 미설정 self-hosted 에 통합 설정 딥링크, 아니면 안내 문구
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
      else setActionError(r.error ?? '연결을 시작하지 못했어요.')
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
          GitHub 같은 외부 계정을 연결해요. 이 연결은 워크스페이스가 아닌 내 계정 소유라, 내가 속한
          어느 워크스페이스에서든 보여요. 연결 정보는 비공개 저장소 가져오기·결과 게시·알림에 쓰이고
          안전하게 암호화돼요(값은 다시 표시되지 않아요).
        </p>
      </div>

      {connected && (
        <div className="rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success)]/8 px-3.5 py-1.5 text-[13px] text-[var(--color-success)]">
          {label(connected)} 계정을 연결했어요.
        </div>
      )}
      {error && (
        <Callout tone="danger" className="py-1.5">
          {ERROR_COPY[error] ?? `연결하지 못했어요: ${error}`}
        </Callout>
      )}

      {connections.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">아직 연결한 계정이 없어요.</p>
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

      {/* 공식 지원 provider 카탈로그 — 항상 3종 전부 노출. 각 행은 좌(이름/설명)·우(상태별 컨트롤). */}
      <div className="space-y-2">
        <p className="text-[13px] font-[510] text-foreground">서비스 연결</p>
        {providers.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            연결할 수 있는 서비스가 없어요.
          </p>
        ) : (
          <>
            <SettingsList>
              {providers.map((p) => (
                <SettingsRow key={p.id} label={label(p.id)} hint={PROVIDER_DESC[p.id]}>
                  {p.connectable ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={pending}
                      onClick={() => onConnect(p.id)}
                    >
                      연결
                    </Button>
                  ) : p.selfHosted ? (
                    canManageIntegrations ? (
                      <Link
                        href={`/${encodeURIComponent(workspace)}/settings?tab=integrations`}
                        className="text-[12px] font-[510] text-primary hover:underline"
                      >
                        통합 설정 →
                      </Link>
                    ) : (
                      <span className="text-[12px] text-muted-foreground">관리자 설정 필요</span>
                    )
                  ) : (
                    <span className="text-[12px] text-muted-foreground">관리자 설정 필요</span>
                  )}
                </SettingsRow>
              ))}
            </SettingsList>
            <p className="text-[12px] text-faint">
              연결을 누르면 로그인 화면으로 갔다가 이 페이지로 돌아와요. GitHub Enterprise·Mattermost
              는 관리자가 워크스페이스 설정의 통합 탭에서 등록하면 연결할 수 있어요.
            </p>
          </>
        )}
        {actionError && (
          <Callout tone="danger" className="py-1.5">
            {actionError}
          </Callout>
        )}
      </div>
    </div>
  )
}
