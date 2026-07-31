'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'

import { SecretPicker } from '@/features/pick-secret'
import type { MattermostConfig } from '@/entities/mattermost'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import {
  probeMattermostAction,
  removeMattermostAction,
  setMattermostAction,
} from '../api/manage-mattermost'

// Workspace-owned Mattermost connections — an admin registers one bot + channel per team/purpose against the
// operator's server; run/scorecard completion & regression notifications are posted to EVERY connection that has a
// channel. Bot/command token values are stored only as workspace secret references (names). The server URL is
// deployment infrastructure (MATTERMOST_HOST) and is never shown or entered here — serverHost only tells us whether
// the integration is usable at all. Registration requires a verified connection first (Test connection → the control
// plane also re-verifies strictly on save).
// Rendered inside the Integrations detail — the panel owns the title/InfoTip, so this renders content only.
export function MattermostManager({
  serverHost,
  connections,
  canWrite,
  secretNames,
}: {
  serverHost?: string
  connections: MattermostConfig[]
  canWrite: boolean
  secretNames: string[]
}) {
  const t = useTranslations('manageMattermost')
  const [pending, startTransition] = useTransition()
  const [probing, startProbing] = useTransition()
  const [error, setError] = useState<string>()
  // Edit target name — a row's Edit prefills the form (save is an upsert keyed by name). undefined = add a connection.
  const [editing, setEditing] = useState<string>()
  const [name, setName] = useState('')
  const [tokenName, setTokenName] = useState('')
  const [channel, setChannel] = useState('')
  const [cmdName, setCmdName] = useState('')
  const [created, setCreated] = useState<string[]>([])
  // Verified-connection gate — Save is enabled only after a reachable probe for the CURRENT token+channel pair.
  const [verified, setVerified] = useState<{
    probeKey: string
    botUsername?: string
    channelName?: string
  }>()
  const [probeReason, setProbeReason] = useState<string>()
  const names = [...new Set([...secretNames, ...created])]

  // The fingerprint the probe must match — editing the bot token or channel invalidates a prior test.
  const probeKey = `${tokenName.trim()}|${channel.trim()}`
  const probeFresh = verified?.probeKey === probeKey
  const canSave = probeFresh && name.trim() !== '' && !pending
  // The inbound URLs are workspace-level (routed by ?ws=), so they're shown once for whichever connection enabled them.
  const inbound = connections.find((c) => c.commandUrl)

  // Operator hasn't configured a Mattermost server — nothing to register a bot against.
  if (!serverHost) {
    return (
      <Callout tone="warning" className="py-1.5">
        {t('serverNotConfigured')}
      </Callout>
    )
  }

  function resetForm() {
    setEditing(undefined)
    setName('')
    setTokenName('')
    setChannel('')
    setCmdName('')
    setVerified(undefined)
    setProbeReason(undefined)
  }

  function startEdit(c: MattermostConfig) {
    setError(undefined)
    setEditing(c.name)
    setName(c.name)
    setTokenName(c.botTokenSecretName)
    setChannel(c.defaultChannelId ?? '')
    setCmdName(c.commandTokenSecretName ?? '')
    setVerified(undefined) // editing requires re-testing the connection
    setProbeReason(undefined)
  }

  function onTest() {
    setError(undefined)
    if (!tokenName.trim()) {
      setError(t('validationToken'))
      return
    }
    const key = probeKey
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
          probeKey: key,
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
    if (!name.trim()) {
      setError(t('validationName'))
      return
    }
    startTransition(async () => {
      const r = await setMattermostAction({
        name: name.trim(),
        botTokenSecretName: tokenName.trim(),
        ...(channel.trim() ? { defaultChannelId: channel.trim() } : {}),
        ...(cmdName.trim() ? { commandTokenSecretName: cmdName.trim() } : {}),
      })
      if (!r.ok) setError(r.error)
      else resetForm()
    })
  }

  function onRemove(target: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await removeMattermostAction(target)
      if (!r.ok) setError(r.error)
      else if (editing === target) resetForm()
    })
  }

  return (
    <div className="space-y-3">
      {connections.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('empty')}</p>
      ) : (
        <SettingsList>
          {connections.map((c) => (
            <SettingsRow
              key={c.name}
              label={
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  {c.name}
                  {c.defaultChannelId ? (
                    <code className="rounded border border-border bg-muted/40 px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">
                      {c.defaultChannelId}
                    </code>
                  ) : (
                    <Badge tone="outline">{t('noChannel')}</Badge>
                  )}
                  {c.commandTokenSecretName && <Badge tone="success">{t('inboundEnabled')}</Badge>}
                </span>
              }
              hint={t('botTokenRef', { name: c.botTokenSecretName })}
            >
              {canWrite && (
                <>
                  <button
                    type="button"
                    className="text-[12px] font-[510] text-link hover:text-foreground"
                    disabled={pending}
                    onClick={() => startEdit(c)}
                  >
                    {t('edit')}
                  </button>
                  <button
                    type="button"
                    className="text-[12px] font-[510] text-destructive hover:underline"
                    disabled={pending}
                    onClick={() => onRemove(c.name)}
                  >
                    {t('remove')}
                  </button>
                </>
              )}
            </SettingsRow>
          ))}
        </SettingsList>
      )}

      {inbound && (
        <div className="space-y-1 rounded-md border bg-elevated px-3 py-2 text-[12px]">
          <p className="font-[510] text-foreground">{t('inboundUrlTitle')}</p>
          <p className="text-muted-foreground">
            {t('commandRequestUrl')}{' '}
            <code className="break-all text-foreground">{inbound.commandUrl}</code>
          </p>
          {inbound.actionUrl && (
            <p className="text-muted-foreground">
              {t('buttonActionUrl')}{' '}
              <code className="break-all text-foreground">{inbound.actionUrl}</code>
            </p>
          )}
        </div>
      )}

      {canWrite ? (
        <div className="@container space-y-3 rounded-lg border bg-card p-4 shadow-raise">
          <p className="text-[12px] font-[560] text-foreground">
            {editing ? t('editTitle', { name: editing }) : t('addTitle')}
          </p>
          <div className="grid gap-3 @md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="mm-name">{t('nameLabel')}</Label>
              {/* name = upsert key — locked while editing so a rename can't silently fork a second connection. */}
              <Input
                id="mm-name"
                placeholder={t('namePlaceholder')}
                value={name}
                disabled={editing !== undefined}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
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
            {probeFresh && verified && (
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

          <div className="flex items-center gap-3">
            <Button size="sm" disabled={!canSave} onClick={onSave}>
              {pending ? t('saving') : editing ? t('update') : t('register')}
            </Button>
            {!probeFresh && <span className="text-[12px] text-faint">{t('verifyFirst')}</span>}
            {editing && (
              <button
                type="button"
                className="text-[12px] text-muted-foreground hover:text-foreground"
                disabled={pending}
                onClick={resetForm}
              >
                {t('cancel')}
              </button>
            )}
          </div>
        </div>
      ) : (
        connections.length === 0 && (
          <p className="text-[13px] text-muted-foreground">{t('notConfigured')}</p>
        )
      )}

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}
