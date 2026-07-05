'use client'

import { useState, useTransition } from 'react'

import type { MattermostConfig } from '@/entities/mattermost'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'

import { removeMattermostAction, setMattermostAction } from '../api/manage-mattermost'

// 워크스페이스 소유 Mattermost 통합 — 사내 Mattermost 를 관리자가 등록하면 실행·스코어카드 완료/회귀 알림을
// bot 토큰으로 채널에 게시한다(개인 연결 대체). bot 토큰 값은 워크스페이스 시크릿에 먼저 저장하고 그 이름만 지정.
export function MattermostManager({
  config,
  canWrite,
}: {
  config?: MattermostConfig
  canWrite: boolean
}) {
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const [host, setHost] = useState(config?.host ?? '')
  const [tokenName, setTokenName] = useState(config?.botTokenSecretName ?? '')
  const [channel, setChannel] = useState(config?.defaultChannelId ?? '')

  function onSave() {
    setError(undefined)
    if (!host.trim() || !tokenName.trim()) {
      setError('서버 URL 과 bot 토큰 시크릿 이름을 입력해주세요.')
      return
    }
    startTransition(async () => {
      const r = await setMattermostAction({
        host: host.trim(),
        botTokenSecretName: tokenName.trim(),
        ...(channel.trim() ? { defaultChannelId: channel.trim() } : {}),
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
                bot 토큰 값은 워크스페이스 시크릿(모델 키 탭)에 먼저 저장하고 여기엔 그 이름만
                지정해요.
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
            <div className="space-y-1">
              <Label htmlFor="mm-token">bot 토큰 시크릿 이름</Label>
              <Input
                id="mm-token"
                placeholder="MATTERMOST_BOT_TOKEN"
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
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
          </div>
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
