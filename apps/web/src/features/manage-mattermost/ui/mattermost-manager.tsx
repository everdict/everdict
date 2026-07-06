'use client'

import { useState, useTransition } from 'react'

import { SecretPicker } from '@/features/pick-secret'
import type { MattermostConfig } from '@/entities/mattermost'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'

import { removeMattermostAction, setMattermostAction } from '../api/manage-mattermost'

// 워크스페이스 소유 Mattermost 통합 — 사내 Mattermost 를 관리자가 등록하면 실행·스코어카드 완료/회귀 알림을
// bot 토큰으로 채널에 게시한다(개인 연결 대체). bot 토큰 값은 워크스페이스 시크릿 참조(이름)로만 저장.
// secretNames = 워크스페이스 시크릿 이름(토큰 피커용 — 값은 안 옴). 두 피커가 목록을 공유하므로
// 인라인 생성분은 created 로 합류시킨다.
export function MattermostManager({
  config,
  canWrite,
  secretNames,
}: {
  config?: MattermostConfig
  canWrite: boolean
  secretNames: string[]
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const [host, setHost] = useState(config?.host ?? '')
  const [tokenName, setTokenName] = useState(config?.botTokenSecretName ?? '')
  const [channel, setChannel] = useState(config?.defaultChannelId ?? '')
  const [cmdName, setCmdName] = useState(config?.commandTokenSecretName ?? '')
  const [created, setCreated] = useState<string[]>([])
  const names = [...new Set([...secretNames, ...created])]

  function onSave() {
    setError(undefined)
    if (!host.trim() || !tokenName.trim()) {
      setError('서버 URL 을 입력하고 bot 토큰 시크릿을 선택해주세요.')
      return
    }
    startTransition(async () => {
      const r = await setMattermostAction({
        host: host.trim(),
        botTokenSecretName: tokenName.trim(),
        ...(channel.trim() ? { defaultChannelId: channel.trim() } : {}),
        ...(cmdName.trim() ? { commandTokenSecretName: cmdName.trim() } : {}),
      })
      if (!r.ok) setError(r.error)
    })
  }
  function onRemove() {
    setError(undefined)
    startTransition(async () => {
      const r = await removeMattermostAction()
      if (r.ok) {
        setHost('')
        setTokenName('')
        setChannel('')
      } else setError(r.error)
    })
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h3 className="flex items-center gap-1.5 text-[13px] font-[560] text-foreground">
          Mattermost 알림
          <InfoTip
            content={
              <>
                사내 Mattermost 를 등록하면 실행·스코어카드 완료와 회귀를 채널에 자동으로 알려요.
                bot 토큰은 워크스페이스 시크릿에서 고르거나 “새로”로 바로 저장해요 — 여기엔 그
                이름만 남아요.
              </>
            }
          />
        </h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          워크스페이스 단위로 한 번 등록하면 팀 전체 알림에 쓰여요.
        </p>
      </div>

      {canWrite ? (
        <div className="space-y-3 rounded-lg border bg-card p-4 shadow-raise">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="mm-host">서버 URL</Label>
              <Input
                id="mm-host"
                placeholder="https://mattermost.corp.io"
                value={host}
                onChange={(e) => setHost(e.target.value)}
              />
            </div>
            {/* bot 토큰은 자유 텍스트가 아니라 워크스페이스 시크릿 참조 — 고르거나 인라인 생성. */}
            <div className="space-y-1">
              <Label htmlFor="mm-token">bot 토큰 시크릿</Label>
              <SecretPicker
                id="mm-token"
                value={tokenName}
                onChange={setTokenName}
                names={names}
                scope="workspace"
                onCreated={(n) => setCreated((c) => [...c, n])}
                createValuePlaceholder="bot 토큰 붙여넣기"
                aria-label="bot 토큰 시크릿 선택"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="mm-channel">알림 채널 id</Label>
              <Input
                id="mm-channel"
                placeholder="채널 id (완료/회귀 알림 대상)"
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="mm-cmd" className="flex items-center gap-1.5">
                채팅 명령 토큰 시크릿 (선택)
                <InfoTip
                  content={
                    <>
                      Mattermost 에서 <span className="font-mono">/assay</span> 슬래시커맨드를 만들
                      때 발급되는 토큰이에요. 워크스페이스 시크릿에서 고르거나 바로 저장해요.
                      설정하면 채팅에서 실행·조회가 가능해지고, 아래 인바운드 URL 을 커맨드에
                      등록해요.
                    </>
                  }
                />
              </Label>
              <SecretPicker
                id="mm-cmd"
                value={cmdName}
                onChange={setCmdName}
                names={names}
                scope="workspace"
                onCreated={(n) => setCreated((c) => [...c, n])}
                createValuePlaceholder="슬래시커맨드 토큰 붙여넣기"
                aria-label="채팅 명령 토큰 시크릿 선택"
              />
            </div>
          </div>

          {config?.commandUrl && (
            <div className="space-y-1 rounded-md border bg-elevated px-3 py-2 text-[12px]">
              <p className="font-[510] text-foreground">Mattermost 에 등록할 인바운드 URL</p>
              <p className="text-muted-foreground">
                슬래시커맨드 요청 URL:{' '}
                <code className="break-all text-foreground">{config.commandUrl}</code>
              </p>
              {config.actionUrl && (
                <p className="text-muted-foreground">
                  버튼 액션 URL:{' '}
                  <code className="break-all text-foreground">{config.actionUrl}</code>
                </p>
              )}
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
        <p className="text-[13px] text-muted-foreground">{config.host} 에 알림이 연결돼 있어요.</p>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          아직 Mattermost 알림이 설정되지 않았어요.
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
