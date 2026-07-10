'use client'

import { useState, useTransition } from 'react'
import { useLocale, useTranslations } from 'next-intl'

import { SecretPicker } from '@/features/pick-secret'
import type { GithubAppInstallation, GithubAppView } from '@/entities/github-app'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Input, Label } from '@/shared/ui/input'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'
import { InfoTip } from '@/shared/ui/tooltip'

import {
  registerGithubAppAction,
  removeGithubAppRegistrationAction,
  startGithubAppInstallAction,
  unlinkGithubAppInstallationAction,
} from '../api/manage-github-app'

// Human-readable notice for the install-callback redirect (?githubApp=installed / ?error=…) — explicit feedback right after install.
export interface GithubAppNotice {
  installed?: boolean
  error?: string
}
// Install-callback error code → message key (resolves human-readable text from the catalog).
const INSTALL_ERROR_KEYS: Record<string, string> = {
  missing_state: 'installErrorMissingState',
  invalid_state: 'installErrorInvalidState',
  missing_installation: 'installErrorMissingInstallation',
  install_failed: 'installErrorInstallFailed',
}

// Workspace-owned GitHub App integration — org install → selected repos → workspace-owned installation (replaces personal connections).
// github.com is one-click install (operator env App); GHE requires an admin to register each server's App, then install. authZ is enforced by the control plane.
// The install list shows github.com and GHE in the same shape (account + host chip + installed badge + allowed-repo chips) — consistency.
// secretNames = workspace secret names (for the GHE private-key picker — values are not sent).
export function GithubAppManager({
  view,
  canWrite,
  secretNames,
  notice,
}: {
  view: GithubAppView
  canWrite: boolean
  secretNames: string[]
  notice?: GithubAppNotice
}) {
  const t = useTranslations('manageGithubApp')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const [showGhe, setShowGhe] = useState(view.registrations.length > 0)
  const noticeErrorKey = notice?.error ? INSTALL_ERROR_KEYS[notice.error] : undefined

  function onInstall(host?: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await startGithubAppInstallAction(host)
      // Install in a new tab — proceed through the GitHub install flow without leaving the settings screen.
      if (r.ok && r.installUrl) window.open(r.installUrl, '_blank', 'noopener,noreferrer')
      else setError(r.error ?? t('installStartFailed'))
    })
  }
  function onUnlink(installationId: number) {
    setError(undefined)
    startTransition(async () => {
      const r = await unlinkGithubAppInstallationAction(installationId)
      if (!r.ok) setError(r.error)
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

      {/* Feedback right after the install callback — the moment we return from GitHub, explicitly say "succeeded/failed". */}
      {notice?.installed && (
        <Callout tone="info" className="py-1.5">
          {t('installedNotice')}
        </Callout>
      )}
      {notice?.error && (
        <Callout tone="danger" className="py-1.5">
          {noticeErrorKey ? t(noticeErrorKey) : t('installFailedGeneric', { code: notice.error })}
        </Callout>
      )}

      {view.installations.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-card/40 px-4 py-5">
          <p className="text-[13px] text-muted-foreground">{t('emptyTitle')}</p>
          <p className="mt-1 text-[12px] text-faint">
            {canWrite ? t('emptyHintCanWrite') : t('emptyHintReadOnly')}
          </p>
        </div>
      ) : (
        <SettingsList>
          {view.installations.map((i) => (
            <InstallationRow
              key={i.installationId}
              install={i}
              canWrite={canWrite}
              pending={pending}
              onUnlink={onUnlink}
            />
          ))}
        </SettingsList>
      )}

      {canWrite && (
        <div className="flex items-center gap-3">
          <Button variant="secondary" size="sm" disabled={pending} onClick={() => onInstall()}>
            {t('installButton')}
          </Button>
          <button
            type="button"
            className="text-[12px] font-[510] text-primary hover:underline"
            onClick={() => setShowGhe((v) => !v)}
          >
            {t('gheToggle')}
          </button>
        </div>
      )}

      {canWrite && showGhe && (
        <GheSection
          view={view}
          secretNames={secretNames}
          pending={pending}
          onInstall={onInstall}
          onError={setError}
        />
      )}

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}
    </div>
  )
}

// Number of allowed-repo chips to show before collapsing — the rest expand behind a "+n more" toggle.
const REPO_PREVIEW_COUNT = 6

// A single installation — github.com and GHE in the same shape: account + host chip (always) + installed badge + allowed-repo chip list.
function InstallationRow({
  install,
  canWrite,
  pending,
  onUnlink,
}: {
  install: GithubAppInstallation
  canWrite: boolean
  pending: boolean
  onUnlink: (installationId: number) => void
}) {
  const t = useTranslations('manageGithubApp')
  const locale = useLocale()
  const [expanded, setExpanded] = useState(false)
  const repos = install.repos ?? []
  const shown = expanded ? repos : repos.slice(0, REPO_PREVIEW_COUNT)
  return (
    <SettingsRow
      label={
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-[560] text-foreground">{install.account}</span>
          <span className="rounded border border-border bg-muted/40 px-1.5 py-px font-mono text-[10.5px] font-normal text-muted-foreground">
            {hostLabel(install.host)}
          </span>
        </span>
      }
      hint={
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span>
            {t('installedOn', {
              date: new Date(install.connectedAt).toLocaleDateString(locale),
            })}
          </span>
          <span>·</span>
          {install.reposError ? (
            <span className="text-[var(--color-warning)]">{install.reposError}</span>
          ) : repos.length === 0 ? (
            <span>{t('noReposHint')}</span>
          ) : (
            <>
              <span>{t('allowedRepos', { count: repos.length })}</span>
              {shown.map((r) => (
                <code
                  key={r.fullName}
                  className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-foreground/85"
                >
                  {r.fullName}
                </code>
              ))}
              {repos.length > REPO_PREVIEW_COUNT && (
                <button
                  type="button"
                  className="text-[12px] font-[510] text-link hover:text-foreground"
                  onClick={() => setExpanded((v) => !v)}
                >
                  {expanded
                    ? t('collapse')
                    : t('moreRepos', { count: repos.length - REPO_PREVIEW_COUNT })}
                </button>
              )}
            </>
          )}
        </span>
      }
    >
      <Badge tone="success">{t('installedBadge')}</Badge>
      {canWrite && (
        <button
          type="button"
          className="text-[12px] font-[510] text-destructive hover:underline"
          disabled={pending}
          onClick={() => onUnlink(install.installationId)}
        >
          {t('unlink')}
        </button>
      )}
    </SettingsRow>
  )
}

// GitHub Enterprise — create an App on each GHE server and register it (host+slug+appId+private-key SecretStore name), then install.
// The registration row shows install status (installed/not installed) to carry the same "status-visible" flow as github.com.
function GheSection({
  view,
  secretNames,
  pending,
  onInstall,
  onError,
}: {
  view: GithubAppView
  secretNames: string[]
  pending: boolean
  onInstall: (host: string) => void
  onError: (msg?: string) => void
}) {
  const t = useTranslations('manageGithubApp')
  const [saving, startSaving] = useTransition()
  const [host, setHost] = useState('')
  const [slug, setSlug] = useState('')
  const [appId, setAppId] = useState('')
  const [keyName, setKeyName] = useState('')

  function onRegister() {
    onError(undefined)
    if (!host.trim() || !slug.trim() || !appId.trim() || !keyName.trim()) {
      onError(t('allFieldsRequired'))
      return
    }
    startSaving(async () => {
      const r = await registerGithubAppAction({
        host: host.trim(),
        slug: slug.trim(),
        appId: appId.trim(),
        privateKeySecretName: keyName.trim(),
      })
      if (r.ok) {
        setHost('')
        setSlug('')
        setAppId('')
        setKeyName('')
      } else onError(r.error)
    })
  }
  function onRemove(h: string) {
    onError(undefined)
    startSaving(async () => {
      const r = await removeGithubAppRegistrationAction(h)
      if (!r.ok) onError(r.error)
    })
  }

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4 shadow-raise">
      <h4 className="flex items-center gap-1.5 text-[13px] font-[560] text-foreground">
        {t('gheServerTitle')}
        <InfoTip
          content={
            <>
              {t('gheTip')}
              {view.callbackUrl && (
                <>
                  <br />
                  {t('gheSetupUrl')} <code>{view.callbackUrl}</code>
                </>
              )}
            </>
          }
        />
      </h4>

      {view.registrations.length > 0 && (
        <SettingsList>
          {view.registrations.map((r) => {
            // Orgs installed on this GHE server — SERVED by the control plane (installedAccounts, P1g);
            // host normalization has exactly one owner (the server's sameHost), so the mirror is gone.
            const installedOrgs = r.installedAccounts ?? []
            return (
              <SettingsRow
                key={r.host}
                label={
                  <span className="flex flex-wrap items-center gap-2">
                    {hostLabel(r.host)}
                    {installedOrgs.length > 0 ? (
                      <Badge tone="success">
                        {t('installedOrgsBadge', {
                          orgs: installedOrgs.join(', '),
                        })}
                      </Badge>
                    ) : (
                      <Badge tone="outline">{t('notInstalledBadge')}</Badge>
                    )}
                  </span>
                }
                hint={t('gheRegHint', { appId: r.appId, slug: r.slug })}
              >
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pending}
                  onClick={() => onInstall(r.host)}
                >
                  {t('installShort')}
                </Button>
                <button
                  type="button"
                  className="text-[12px] font-[510] text-destructive hover:underline"
                  disabled={saving}
                  onClick={() => onRemove(r.host)}
                >
                  {t('delete')}
                </button>
              </SettingsRow>
            )
          })}
        </SettingsList>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="ghe-host">{t('serverUrl')}</Label>
          <Input
            id="ghe-host"
            placeholder="https://ghe.example.com"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ghe-slug">App slug</Label>
          <Input
            id="ghe-slug"
            placeholder="everdict-eval"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ghe-appid">App ID</Label>
          <Input
            id="ghe-appid"
            placeholder="123456"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
          />
        </div>
        {/* The private key (PEM) is a workspace secret reference, not free-text input — pick one or create inline (multiline by default). */}
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="ghe-key">{t('privateKeySecret')}</Label>
          <SecretPicker
            id="ghe-key"
            value={keyName}
            onChange={setKeyName}
            names={secretNames}
            scope="workspace"
            defaultMultiline
            createValuePlaceholder={t('privateKeyPlaceholder')}
            aria-label={t('privateKeyAria')}
          />
        </div>
      </div>
      <Button size="sm" disabled={saving} onClick={onRegister}>
        {saving ? t('saving') : t('registerApp')}
      </Button>
    </div>
  )
}

// "https://ghe.example.com" → "ghe.example.com"; a github.com install (no host) is "github.com" — always shown as a chip for consistency.
function hostLabel(host?: string): string {
  if (!host) return 'github.com'
  try {
    return new URL(host).host
  } catch {
    return host
  }
}
