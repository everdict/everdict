'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'

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
  const t = useTranslations('manageMattermost')
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
      setError(t('validationServerToken'))
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
          {t('title')}
          <InfoTip content={t('titleTip')} />
        </h3>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{t('description')}</p>
      </div>

      {canWrite ? (
        <div className="space-y-3 rounded-lg border bg-card p-4 shadow-raise">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="mm-host">{t('serverUrl')}</Label>
              <Input
                id="mm-host"
                placeholder="https://mattermost.corp.io"
                value={host}
                onChange={(e) => setHost(e.target.value)}
              />
            </div>
            {/* bot 토큰은 자유 텍스트가 아니라 워크스페이스 시크릿 참조 — 고르거나 인라인 생성. */}
            <div className="space-y-1">
              <Label htmlFor="mm-token">{t('botTokenSecret')}</Label>
              <SecretPicker
                id="mm-token"
                value={tokenName}
                onChange={setTokenName}
                names={names}
                scope="workspace"
                onCreated={(n) => setCreated((c) => [...c, n])}
                createValuePlaceholder={t('botTokenPlaceholder')}
                aria-label={t('botTokenAria')}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="mm-channel">{t('channelId')}</Label>
              <Input
                id="mm-channel"
                placeholder={t('channelPlaceholder')}
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="mm-cmd" className="flex items-center gap-1.5">
                {t('commandTokenSecret')}
                <InfoTip
                  content={t.rich('commandTokenTip', {
                    mono: (chunks) => <span className="font-mono">{chunks}</span>,
                  })}
                />
              </Label>
              <SecretPicker
                id="mm-cmd"
                value={cmdName}
                onChange={setCmdName}
                names={names}
                scope="workspace"
                onCreated={(n) => setCreated((c) => [...c, n])}
                createValuePlaceholder={t('commandTokenPlaceholder')}
                aria-label={t('commandTokenAria')}
              />
            </div>
          </div>

          {config?.commandUrl && (
            <div className="space-y-1 rounded-md border bg-elevated px-3 py-2 text-[12px]">
              <p className="font-[510] text-foreground">{t('inboundUrlTitle')}</p>
              <p className="text-muted-foreground">
                {t('commandRequestUrl')}{' '}
                <code className="break-all text-foreground">{config.commandUrl}</code>
              </p>
              {config.actionUrl && (
                <p className="text-muted-foreground">
                  {t('buttonActionUrl')}{' '}
                  <code className="break-all text-foreground">{config.actionUrl}</code>
                </p>
              )}
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button size="sm" disabled={pending} onClick={onSave}>
              {pending ? t('saving') : config ? t('update') : t('register')}
            </Button>
            {config && (
              <button
                type="button"
                className="text-[12px] font-[510] text-destructive hover:underline"
                disabled={pending}
                onClick={onRemove}
              >
                {t('remove')}
              </button>
            )}
          </div>
        </div>
      ) : config ? (
        <p className="text-[13px] text-muted-foreground">
          {t('connectedTo', { host: config.host })}
        </p>
      ) : (
        <p className="text-[13px] text-muted-foreground">{t('notConfigured')}</p>
      )}

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}
