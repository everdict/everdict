'use client'

import { useEffect, useState, useTransition } from 'react'
import { Check, Copy, Github, Lock, Search, Server, Trash2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import type { GithubAppInstallation, GithubAppView } from '@/entities/github-app'
import {
  capabilityMeta,
  type GithubRunnerInstall,
  type RunnerCapability,
  type RunnerMeta,
} from '@/entities/runner'
import { copyText } from '@/shared/lib/clipboard'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input, Label } from '@/shared/ui/input'

import {
  githubInstallRunnerAction,
  pairWorkspaceRunnerAction,
  revokeWorkspaceRunnerAction,
} from '../api/manage-workspace-runners'

// Online check — a runner refreshes lastSeenAt on every long-poll lease (~25s), so within 90s it counts as connected.
const ONLINE_WINDOW_MS = 90_000
function isOnline(lastSeenAt?: string): boolean {
  return lastSeenAt !== undefined && Date.now() - new Date(lastSeenAt).getTime() < ONLINE_WINDOW_MS
}

// Workspace-shared runner (team resource) — once an admin registers a headless runner (team build server/CI),
// any member of this workspace can target it via self:ws:<id>. Unlike personal runners (account page, one-click
// desktop), the token is shown once and attached on the server via `everdict runner --pair`. Register/revoke is
// admin-only (settings:write) — the control plane enforces it.
export function WorkspaceRunnersManager({
  runners,
  canWrite,
  githubApp,
  onOpenIntegrations,
}: {
  runners: RunnerMeta[]
  canWrite: boolean
  githubApp: GithubAppView // Target list for the GitHub Actions runner registration picker (installations + allowed repos) — same snapshot as the Integrations tab
  onOpenIntegrations?: () => void // "Install/manage GitHub App" CTA — switch to the Integrations tab (same settings page)
}) {
  const t = useTranslations('manageWorkspaceRunners')
  const locale = useLocale()
  const [registerOpen, setRegisterOpen] = useState(false)
  const [githubOpen, setGithubOpen] = useState(false)
  const [confirmId, setConfirmId] = useState<string>()
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  function onRevoke(id: string) {
    setError(undefined)
    startTransition(async () => {
      const r = await revokeWorkspaceRunnerAction(id)
      setConfirmId(undefined)
      if (!r.ok) setError(r.error)
    })
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-[13px] font-[560] text-foreground">{t('title')}</h3>
          <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
            {t.rich('description', {
              target: 'self:ws:<id>',
              mono: (chunks) => <span className="font-mono">{chunks}</span>,
            })}
          </p>
        </div>
        {canWrite && (
          <span className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setGithubOpen(true)}>
              <Github />
              {t('githubRunner')}
            </Button>
            <Button size="sm" onClick={() => setRegisterOpen(true)}>
              <Server />
              {t('registerRunner')}
            </Button>
          </span>
        )}
      </div>

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}

      {runners.length === 0 ? (
        <EmptyState
          icon={<Server strokeWidth={1.75} />}
          title={t('emptyTitle')}
          hint={canWrite ? t('emptyHintCanWrite') : t('emptyHintReadOnly')}
          action={
            canWrite ? (
              <Button size="sm" variant="secondary" onClick={() => setRegisterOpen(true)}>
                <Server />
                {t('registerRunner')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border bg-card shadow-raise">
          {runners.map((r) => {
            const online = isOnline(r.lastSeenAt)
            return (
              <li key={r.id} className="flex items-center gap-3 px-3.5 py-3">
                <span className="relative grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground">
                  <Server className="size-4" strokeWidth={1.75} />
                  <span
                    className={cn(
                      'absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card',
                      online ? 'bg-[var(--color-success)]' : 'bg-muted-foreground/40'
                    )}
                    title={online ? t('online') : t('offline')}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13px] font-[510] text-foreground">
                      {r.label}
                    </span>
                    <span
                      className={cn(
                        'text-[12px]',
                        online ? 'text-[var(--color-success)]' : 'text-faint'
                      )}
                    >
                      {online ? t('online') : t('offline')}
                    </span>
                    {r.os && <Badge tone="outline">{r.os}</Badge>}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    {capabilityMeta.map(({ name, label }) => {
                      const has = r.capabilities.includes(name)
                      return (
                        <Badge
                          key={name}
                          tone={has ? 'success' : 'outline'}
                          className={has ? undefined : 'opacity-55'}
                          title={has ? t('capSupported') : t('capUnsupported')}
                        >
                          {has ? '✓ ' : ''}
                          {label}
                        </Badge>
                      )
                    })}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-faint">
                    <code className="font-mono text-muted-foreground">self:ws:{r.id}</code>
                    <span>·</span>
                    <span>
                      {t('pairedAt', { date: new Date(r.pairedAt).toLocaleString(locale) })}
                    </span>
                  </div>
                </div>
                {canWrite &&
                  (confirmId === r.id ? (
                    <span className="flex shrink-0 items-center gap-2">
                      <Button
                        variant="destructive"
                        size="xs"
                        disabled={pending}
                        onClick={() => onRevoke(r.id)}
                      >
                        {t('revokeConfirm')}
                      </Button>
                      <button
                        type="button"
                        className="text-[12px] text-muted-foreground hover:text-foreground"
                        onClick={() => setConfirmId(undefined)}
                      >
                        {t('close')}
                      </button>
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label={t('revokeAria', { label: r.label })}
                      onClick={() => setConfirmId(r.id)}
                    >
                      <Trash2 />
                    </Button>
                  ))}
              </li>
            )
          })}
        </ul>
      )}

      {!canWrite && runners.length > 0 && (
        <p className="text-[12px] text-muted-foreground">{t('adminRequired')}</p>
      )}

      {canWrite && (
        <RegisterRunnerDialog open={registerOpen} onClose={() => setRegisterOpen(false)} />
      )}
      {canWrite && (
        <GithubInstallDialog
          open={githubOpen}
          onClose={() => setGithubOpen(false)}
          installations={githubApp.installations}
          {...(onOpenIntegrations !== undefined ? { onOpenIntegrations } : {})}
        />
      )}
    </div>
  )
}

// Register dialog — pick a name + OS (optional) + capabilities, then register. Once registered, the same dialog switches to a step that shows the token once + the attach command.
function RegisterRunnerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations('manageWorkspaceRunners')
  const locale = useLocale()
  const [label, setLabel] = useState('')
  const [os, setOs] = useState('')
  const [caps, setCaps] = useState<RunnerCapability[]>([])
  const [issued, setIssued] = useState<{ token: string; apiUrl?: string }>()
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (!open) return
    setLabel('')
    setOs('')
    setCaps([])
    setIssued(undefined)
    setCopied(false)
    setError(undefined)
  }, [open])

  function toggleCap(name: RunnerCapability) {
    setCaps((prev) => (prev.includes(name) ? prev.filter((c) => c !== name) : [...prev, name]))
  }

  function onRegister() {
    setError(undefined)
    if (label.trim().length === 0) {
      setError(t('nameRequired'))
      return
    }
    startTransition(async () => {
      const r = await pairWorkspaceRunnerAction({
        label: label.trim(),
        ...(os.trim().length > 0 ? { os: os.trim() } : {}),
        ...(caps.length > 0 ? { capabilities: caps } : {}),
      })
      if (r.ok && r.token) setIssued({ token: r.token, ...(r.apiUrl ? { apiUrl: r.apiUrl } : {}) })
      else setError(r.error ?? t('registerFailed'))
    })
  }

  // Command to run when attaching on the server — include apiUrl if present (not a secret).
  const command = issued
    ? `everdict runner --pair --token ${issued.token}${issued.apiUrl ? ` --api-url ${issued.apiUrl}` : ''}`
    : ''

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="max-w-[520px]"
      labelledBy="register-runner-title"
    >
      {issued ? (
        <>
          <header className="border-b border-border px-5 py-4">
            <h2 id="register-runner-title" className="text-[15px] font-[560] text-foreground">
              {t('registeredTitle')}
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {t('registeredDesc')}
            </p>
          </header>
          <div className="px-5 py-4">
            <Callout tone="warning" hint={t('tokenOnceHint')}>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 select-all break-all font-mono text-xs">
                  {command}
                </code>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="shrink-0"
                  onClick={() => {
                    void copyText(command, undefined, locale).then((ok) => ok && setCopied(true))
                  }}
                >
                  {copied ? <Check /> : <Copy />}
                  {copied ? t('copied') : t('copy')}
                </Button>
              </div>
            </Callout>
          </div>
          <footer className="flex justify-end border-t border-border px-5 py-3.5">
            <Button size="sm" onClick={onClose}>
              {t('done')}
            </Button>
          </footer>
        </>
      ) : (
        <>
          <header className="border-b border-border px-5 py-4">
            <h2 id="register-runner-title" className="text-[15px] font-[560] text-foreground">
              {t('registerRunner')}
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {t('registerDesc')}
            </p>
          </header>
          <div className="space-y-4 px-5 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="runner-label">{t('nameLabel')}</Label>
              <Input
                id="runner-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t('namePlaceholder')}
                maxLength={80}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="runner-os">{t('osLabel')}</Label>
              <Input
                id="runner-os"
                value={os}
                onChange={(e) => setOs(e.target.value)}
                placeholder="linux · darwin · win32"
                maxLength={40}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t('capsLabel')}</Label>
              <p className="text-[12px] text-muted-foreground">{t('capsHint')}</p>
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {capabilityMeta.map(({ name, label: capLabel }) => {
                  const on = caps.includes(name)
                  return (
                    <button
                      key={name}
                      type="button"
                      onClick={() => toggleCap(name)}
                      className={cn(
                        'rounded-md border px-2 py-1 text-[12px] transition-colors',
                        on
                          ? 'border-primary/40 bg-primary/10 text-foreground'
                          : 'border-border text-muted-foreground hover:bg-elevated'
                      )}
                    >
                      {on ? '✓ ' : ''}
                      {capLabel}
                    </button>
                  )
                })}
              </div>
            </div>
            {error && (
              <Callout tone="danger" className="py-1.5">
                {error}
              </Callout>
            )}
          </div>
          <footer className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
            <Button size="sm" variant="secondary" onClick={onClose} disabled={pending}>
              {t('cancel')}
            </Button>
            <Button size="sm" onClick={onRegister} disabled={pending}>
              {pending ? t('registering') : t('register')}
            </Button>
          </footer>
        </>
      )}
    </Dialog>
  )
}

// GHE host display strips the URL scheme to just the hostname (github.com is unlabeled) — for the picker row badge.
const hostLabel = (host: string) => host.replace(/^https?:\/\//, '').replace(/\/$/, '')

// Picker selection coordinate — the same "owner/name"/org can exist on both github.com and GHE, so the identifier includes the host.
interface SelectedTarget {
  name: string // repo mode = "owner/name", org mode = org (installation account)
  host?: string // GHE base URL — unset = github.com
}
const targetKey = (s: SelectedTarget) => `${s.host ?? 'github.com'}:${s.name}`

// GitHub Actions runner self-registration dialog — assumes the workspace GitHub App is installed, and picks a
// target from the repos/orgs the installation allows (no raw input; if the App isn't installed, an Integrations-tab
// install CTA). Once generated, it shows once the install script to run on the build server (GitHub runner +
// Everdict runner) and a workflow hint (runs-on label + run-eval runtime).
function GithubInstallDialog({
  open,
  onClose,
  installations,
  onOpenIntegrations,
}: {
  open: boolean
  onClose: () => void
  installations: GithubAppInstallation[]
  onOpenIntegrations?: () => void
}) {
  const t = useTranslations('manageWorkspaceRunners')
  const locale = useLocale()
  const [mode, setMode] = useState<'repo' | 'org'>('repo')
  const [repoQuery, setRepoQuery] = useState('')
  const [repoSel, setRepoSel] = useState<SelectedTarget>()
  const [orgSel, setOrgSel] = useState<SelectedTarget>()
  const [runnerGroup, setRunnerGroup] = useState('')
  const [result, setResult] = useState<GithubRunnerInstall>()
  const [copied, setCopied] = useState<'script' | 'hint'>()
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (!open) return
    setMode('repo')
    setRepoQuery('')
    setRepoSel(undefined)
    setOrgSel(undefined)
    setRunnerGroup('')
    setResult(undefined)
    setCopied(undefined)
    setError(undefined)
  }, [open])

  const installed = installations.length > 0
  // repo picker rows — merge each installation's allowed repos (GHE repos carry their host). Installations that failed to load show as a warning only.
  const repoRows = installations.flatMap((i) =>
    (i.repos ?? []).map((r) => ({
      fullName: r.fullName,
      ...(r.host !== undefined ? { host: r.host } : {}),
      private: r.private,
    }))
  )
  const failedAccounts = installations
    .filter((i) => i.reposError !== undefined)
    .map((i) => i.account)
  const filteredRepos = repoRows.filter((r) =>
    `${r.fullName} ${r.host ? hostLabel(r.host) : ''}`
      .toLowerCase()
      .includes(repoQuery.trim().toLowerCase())
  )

  // "Install App / expand repos" — switch to the Integrations tab (closes the dialog).
  function goToIntegrations() {
    onClose()
    onOpenIntegrations?.()
  }

  function onGenerate() {
    setError(undefined)
    const payload =
      mode === 'org'
        ? orgSel && {
            org: orgSel.name,
            ...(orgSel.host !== undefined ? { host: orgSel.host } : {}),
            ...(runnerGroup.trim() ? { runnerGroup: runnerGroup.trim() } : {}),
          }
        : repoSel && {
            repository: repoSel.name,
            ...(repoSel.host !== undefined ? { host: repoSel.host } : {}),
          }
    if (!payload) {
      setError(mode === 'org' ? t('orgSelectRequired') : t('repoSelectRequired'))
      return
    }
    startTransition(async () => {
      const r = await githubInstallRunnerAction(payload)
      if (r.ok && r.install) setResult(r.install)
      else setError(r.error ?? t('generateFailed'))
    })
  }

  return (
    <Dialog open={open} onClose={onClose} className="max-w-[620px]" labelledBy="gh-install-title">
      {result ? (
        <>
          <header className="border-b border-border px-5 py-4">
            <h2 id="gh-install-title" className="text-[15px] font-[560] text-foreground">
              {t('githubReadyTitle')}
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {t.rich('githubReadyDesc', {
                target: result.runtimeTarget,
                mono: (chunks) => <span className="font-mono">{chunks}</span>,
              })}
            </p>
          </header>
          <div className="space-y-4 px-5 py-4">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>{t('installScriptLabel')}</Label>
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  onClick={() => {
                    void copyText(result.installScript, undefined, locale).then(
                      (ok) => ok && setCopied('script')
                    )
                  }}
                >
                  {copied === 'script' ? <Check /> : <Copy />}
                  {copied === 'script' ? t('copied') : t('copy')}
                </Button>
              </div>
              <pre className="max-h-52 overflow-auto rounded-md border bg-elevated px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {result.installScript}
              </pre>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>{t('workflowLabel')}</Label>
                <Button
                  type="button"
                  variant="secondary"
                  size="xs"
                  onClick={() => {
                    void copyText(result.workflowHint, undefined, locale).then(
                      (ok) => ok && setCopied('hint')
                    )
                  }}
                >
                  {copied === 'hint' ? <Check /> : <Copy />}
                  {copied === 'hint' ? t('copied') : t('copy')}
                </Button>
              </div>
              <pre className="max-h-40 overflow-auto rounded-md border bg-elevated px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {result.workflowHint}
              </pre>
            </div>
            <Callout tone="warning" className="py-1.5">
              {t('registrationExpires', {
                date: new Date(result.registrationExpiresAt).toLocaleString(locale),
              })}
            </Callout>
          </div>
          <footer className="flex justify-end border-t border-border px-5 py-3.5">
            <Button size="sm" onClick={onClose}>
              {t('done')}
            </Button>
          </footer>
        </>
      ) : !installed ? (
        // App not installed — require installation instead of routing around it with raw input (once installed, repos/orgs can be picked directly).
        <>
          <header className="border-b border-border px-5 py-4">
            <h2 id="gh-install-title" className="text-[15px] font-[560] text-foreground">
              {t('githubRegisterTitle')}
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {t('githubRegisterDesc')}
            </p>
          </header>
          <div className="space-y-3 px-5 py-5">
            <Callout tone="info">{t('githubAppRequired')}</Callout>
          </div>
          <footer className="flex justify-end gap-2 border-t border-border px-5 py-3.5">
            <Button size="sm" variant="secondary" onClick={onClose}>
              {t('close')}
            </Button>
            {onOpenIntegrations && (
              <Button size="sm" onClick={goToIntegrations}>
                <Github />
                {t('openIntegrations')}
              </Button>
            )}
          </footer>
        </>
      ) : (
        <>
          <header className="border-b border-border px-5 py-4">
            <h2 id="gh-install-title" className="text-[15px] font-[560] text-foreground">
              {t('githubRegisterTitle')}
            </h2>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {t('githubRegisterDesc')}
            </p>
          </header>
          <div className="max-h-[62vh] space-y-4 overflow-y-auto px-5 py-4">
            {/* Target: repo vs org (org — all repos in that org share it) */}
            <div className="space-y-1.5">
              <Label>{t('targetLabel')}</Label>
              <div className="flex gap-1.5">
                {(['repo', 'org'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={cn(
                      'rounded-md border px-2.5 py-1 text-[12px] transition-colors',
                      mode === m
                        ? 'border-primary/40 bg-primary/10 text-foreground'
                        : 'border-border text-muted-foreground hover:bg-elevated'
                    )}
                  >
                    {m === 'repo' ? t('repo') : t('org')}
                  </button>
                ))}
              </div>
            </div>
            {mode === 'repo' ? (
              // repo picker — only repos the App installation allows (chosen at install time). Search matches repo name + GHE hostname.
              <div className="space-y-1.5">
                <Label>{t('repo')}</Label>
                {failedAccounts.length > 0 && (
                  <Callout tone="warning" className="py-1.5">
                    {t('reposPartialError', { accounts: failedAccounts.join(', ') })}
                  </Callout>
                )}
                {repoRows.length === 0 ? (
                  <Callout tone="info" className="py-1.5">
                    {t('noAllowedRepos')}
                  </Callout>
                ) : (
                  <>
                    <div className="flex items-center gap-1.5 rounded-md border bg-card px-2.5 shadow-raise focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/25">
                      <Search className="size-3.5 shrink-0 text-muted-foreground/70" />
                      <input
                        value={repoQuery}
                        onChange={(e) => setRepoQuery(e.target.value)}
                        placeholder={t('repoSearchPlaceholder')}
                        className="h-8 w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
                      />
                    </div>
                    <div className="max-h-48 divide-y divide-border/70 overflow-y-auto rounded-md border bg-card">
                      {filteredRepos.length === 0 ? (
                        <p className="px-3 py-4 text-center text-[12px] text-muted-foreground">
                          {t('noSearchResults')}
                        </p>
                      ) : (
                        filteredRepos.map((r) => {
                          const row: SelectedTarget = {
                            name: r.fullName,
                            ...(r.host !== undefined ? { host: r.host } : {}),
                          }
                          const active =
                            repoSel !== undefined && targetKey(row) === targetKey(repoSel)
                          return (
                            <button
                              key={targetKey(row)}
                              type="button"
                              onClick={() => setRepoSel(row)}
                              className={cn(
                                'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                                active ? 'bg-accent' : 'hover:bg-accent/60'
                              )}
                            >
                              <Check
                                className={cn(
                                  'size-3.5 shrink-0 text-primary',
                                  active ? 'opacity-100' : 'opacity-0'
                                )}
                              />
                              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
                                {r.fullName}
                              </span>
                              {r.host && (
                                // GHE repo — distinguish which instance it came from by hostname (github.com is unlabeled).
                                <span className="shrink-0 rounded border border-border bg-muted/40 px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">
                                  {hostLabel(r.host)}
                                </span>
                              )}
                              {r.private && (
                                <Lock className="size-3 shrink-0 text-muted-foreground/70" />
                              )}
                            </button>
                          )
                        })
                      )}
                    </div>
                  </>
                )}
              </div>
            ) : (
              // org picker — pick from orgs where the App is installed (all repos in that org share this runner).
              <div className="space-y-1.5">
                <Label>{t('org')}</Label>
                <div className="max-h-48 divide-y divide-border/70 overflow-y-auto rounded-md border bg-card">
                  {installations.map((i) => {
                    const row: SelectedTarget = {
                      name: i.account,
                      ...(i.host !== undefined ? { host: i.host } : {}),
                    }
                    const active = orgSel !== undefined && targetKey(row) === targetKey(orgSel)
                    return (
                      <button
                        key={targetKey(row)}
                        type="button"
                        onClick={() => setOrgSel(row)}
                        className={cn(
                          'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                          active ? 'bg-accent' : 'hover:bg-accent/60'
                        )}
                      >
                        <Check
                          className={cn(
                            'size-3.5 shrink-0 text-primary',
                            active ? 'opacity-100' : 'opacity-0'
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
                          {i.account}
                        </span>
                        {i.host && (
                          <span className="shrink-0 rounded border border-border bg-muted/40 px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">
                            {hostLabel(i.host)}
                          </span>
                        )}
                        {i.repos !== undefined && (
                          <span className="shrink-0 text-[11px] text-faint">
                            {t('orgRepoCount', { count: i.repos.length })}
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
                <p className="text-[12px] text-faint">{t('orgShared')}</p>
                <Input
                  value={runnerGroup}
                  onChange={(e) => setRunnerGroup(e.target.value)}
                  placeholder={t('runnerGroupPlaceholder')}
                />
              </div>
            )}
            {/* If the desired repo/org isn't listed, expand the GitHub App installation (allowed repos) — from the Integrations tab. */}
            {onOpenIntegrations && (
              <p className="text-[12px] text-faint">
                {t('targetMissingHint')}{' '}
                <button
                  type="button"
                  onClick={goToIntegrations}
                  className="font-[510] text-primary hover:underline"
                >
                  {t('manageInstallations')}
                </button>
              </p>
            )}
            {error && (
              <Callout tone="danger" className="py-1.5">
                {error}
              </Callout>
            )}
          </div>
          <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3.5">
            <span className="min-w-0 truncate text-[12px] text-faint">
              {mode === 'repo' && repoSel !== undefined && (
                <span className="font-mono text-muted-foreground">
                  {repoSel.name}
                  {repoSel.host ? ` (${hostLabel(repoSel.host)})` : ''}
                </span>
              )}
              {mode === 'org' && orgSel !== undefined && (
                <span className="font-mono text-muted-foreground">
                  {orgSel.name}
                  {orgSel.host ? ` (${hostLabel(orgSel.host)})` : ''}
                </span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <Button size="sm" variant="secondary" onClick={onClose} disabled={pending}>
                {t('cancel')}
              </Button>
              <Button
                size="sm"
                onClick={onGenerate}
                disabled={
                  pending || (mode === 'repo' ? repoSel === undefined : orgSel === undefined)
                }
              >
                {pending ? t('generating') : t('generateScript')}
              </Button>
            </span>
          </footer>
        </>
      )}
    </Dialog>
  )
}
