'use client'

import { useEffect, useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'

import { SecretPicker } from '@/features/pick-secret'
import type { MattermostConfig } from '@/entities/mattermost'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'

import {
  probeMattermostAction,
  removeMattermostAction,
  setMattermostAction,
} from '../api/manage-mattermost'

// Workspace-owned Mattermost integration — the server URL is operator env (MATTERMOST_HOST), shown read-only. An admin
// registers the workspace's bot token + channel; run/scorecard completion & regression notifications are posted to the
// channel with the bot token (replaces personal connections). The bot token value is stored only as a workspace secret (name).
// Registration requires a verified connection first (Test connection → the control plane also re-verifies strictly on save).
// serverHost = the operator-configured Mattermost URL (absent = operator hasn't set MATTERMOST_HOST). secretNames = token picker.
export function MattermostManager({
  serverHost,
  config,
  canWrite,
  secretNames,
}: {
  serverHost?: string
  config?: MattermostConfig
  canWrite: boolean
  secretNames: string[]
}) {
  const t = useTranslations('manageMattermost')
  const [pending, startTransition] = useTransition()
  const [probing, startProbing] = useTransition()
  const [error, setError] = useState<string>()
  const [tokenName, setTokenName] = useState(config?.botTokenSecretName ?? '')
  const [channel, setChannel] = useState(config?.defaultChannelId ?? '')
  const [cmdName, setCmdName] = useState(config?.commandTokenSecretName ?? '')
  const [created, setCreated] = useState<string[]>([])
  // Verified-connection gate — Save is enabled only after a reachable probe for the CURRENT token+channel. Editing resets it.
  const [verified, setVerified] = useState<{ botUsername?: string; channelName?: string }>()
  const [probeReason, setProbeReason] = useState<string>()
  const names = [...new Set([...secretNames, ...created])]

  // Any change to what we'd verify (bot token or channel) invalidates a prior probe → re-gate Save.
  useEffect(() => {
    setVerified(undefined)
    setProbeReason(undefined)
  }, [tokenName, channel])

  // Operator hasn't configured a Mattermost server — nothing to register a bot against.
  if (!serverHost) {
    return (
      <div className="space-y-3">
        <Header t={t} />
        <Callout tone="warning" className="py-1.5">
          {t('serverNotConfigured')}
        </Callout>
      </div>
    )
  }

  function onTest() {
    setError(undefined)
    if (!tokenName.trim()) {
      setError(t('validationToken'))
      return
    }
    startProbing(async () => {
      const r = await probeMattermostAction({
        botTokenSecretName: tokenName.trim(),
        ...(channel.trim() ? { defaultChannelId: channel.trim() } : {}),
      })
      if (!r.ok) {
        setVerified(undefined)
        setError(r.error)
        return
      }
      if (r.probe?.reachable) {
        setVerified({
          ...(r.probe.botUsername ? { botUsername: r.probe.botUsername } : {}),
          ...(r.probe.channelName ? { channelName: r.probe.channelName } : {}),
        })
        setProbeReason(undefined)
      } else {
        setVerified(undefined)
        setProbeReason(r.probe?.detail ?? t('probeFailed'))
      }
    })
  }

  function onSave() {
    setError(undefined)
    startTransition(async () => {
      const r = await setMattermostAction({
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
        setTokenName('')
        setChannel('')
        setCmdName('')
        setVerified(undefined)
      } else setError(r.error)
    })
  }

  return (
    <div className="space-y-3">
      <Header t={t} />

      {canWrite ? (
        <div className="space-y-3 rounded-lg border bg-card p-4 shadow-raise">
          {/* The server URL is operator env — read-only, never an input. */}
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-elevated px-3 py-2 text-[12px]">
            <span className="font-[510] text-foreground">{t('serverUrl')}</span>
            <code className="break-all text-muted-foreground">{serverHost}</code>
            <InfoTip content={t('serverUrlTip')} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {/* The bot token is a workspace secret reference, not free text — choose or create inline. */}
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

          {/* Connection verification — Save is gated on a reachable probe for the current bot token + channel. */}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" disabled={probing} onClick={onTest}>
              {probing ? t('testing') : t('testConnection')}
            </Button>
            {verified && (
              <Badge tone="success">
                {verified.channelName
                  ? t('verifiedWithChannel', {
                      bot: verified.botUsername ?? t('bot'),
                      channel: verified.channelName,
                    })
                  : t('verifiedBot', { bot: verified.botUsername ?? t('bot') })}
              </Badge>
            )}
          </div>
          {probeReason && (
            <Callout tone="danger" className="py-1.5">
              {t('probeFailedDetail', { detail: probeReason })}
            </Callout>
          )}

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
            <Button size="sm" disabled={pending || !verified} onClick={onSave}>
              {pending ? t('saving') : config ? t('update') : t('register')}
            </Button>
            {!verified && <span className="text-[12px] text-faint">{t('verifyFirst')}</span>}
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
        <p className="text-[13px] text-muted-foreground">{t('connectedTo', { host: serverHost })}</p>
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

function Header({ t }: { t: ReturnType<typeof useTranslations> }) {
  return (
    <div className="space-y-1">
      <h3 className="flex items-center gap-1.5 text-[13px] font-[560] text-foreground">
        {t('title')}
        <InfoTip content={t('titleTip')} />
      </h3>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{t('description')}</p>
    </div>
  )
}
