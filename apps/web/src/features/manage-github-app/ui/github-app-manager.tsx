'use client'

import { useState, useTransition } from 'react'
import { useLocale, useTimeZone, useTranslations } from 'next-intl'

import type { GithubAppInstallation, GithubAppView } from '@/entities/github-app'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'

import {
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
// BOTH github.com and GitHub Enterprise are operator env (one App per host) — the admin only clicks "Install" and picks repos on GitHub.
// The install list shows github.com and GHE in the same shape (account + host chip + installed badge + allowed-repo chips) — consistency.
// Rendered inside the Integrations accordion row — the row owns the title/InfoTip, so this renders content only.
export function GithubAppManager({
  view,
  canWrite,
  notice,
}: {
  view: GithubAppView
  canWrite: boolean
  notice?: GithubAppNotice
}) {
  const t = useTranslations('manageGithubApp')
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string>()
  const noticeErrorKey = notice?.error ? INSTALL_ERROR_KEYS[notice.error] : undefined
  const { githubCom, enterprise } = view.providers
  const noProviderConfigured = !githubCom && !enterprise

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

      {noProviderConfigured ? (
        // Neither github.com nor GitHub Enterprise is configured by the operator (env) — nothing to install against.
        <Callout tone="warning" className="py-1.5">
          {t('noProviderConfigured')}
        </Callout>
      ) : view.installations.length === 0 ? (
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

      {/* One-click install per configured provider — github.com and GitHub Enterprise are handled identically (operator env App). */}
      {canWrite && !noProviderConfigured && (
        <div className="flex flex-wrap items-center gap-2">
          {githubCom && (
            <Button variant="secondary" size="sm" disabled={pending} onClick={() => onInstall()}>
              {t('installGithubCom')}
            </Button>
          )}
          {enterprise && (
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => onInstall(enterprise.host)}
            >
              {t('installEnterprise', { host: hostLabel(enterprise.host) })}
            </Button>
          )}
        </div>
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
  const timeZone = useTimeZone()
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
              date: new Date(install.connectedAt).toLocaleDateString(locale, { timeZone }),
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

// "https://ghe.example.com" → "ghe.example.com"; a github.com install (no host) is "github.com" — always shown as a chip for consistency.
function hostLabel(host?: string): string {
  if (!host) return 'github.com'
  try {
    return new URL(host).host
  } catch {
    return host
  }
}
