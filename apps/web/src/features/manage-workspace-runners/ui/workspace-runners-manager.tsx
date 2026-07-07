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

// 온라인 판정 — 러너는 long-poll lease(~25s)마다 lastSeenAt 을 갱신하므로 90s 안이면 접속 중으로 본다.
const ONLINE_WINDOW_MS = 90_000
function isOnline(lastSeenAt?: string): boolean {
  return lastSeenAt !== undefined && Date.now() - new Date(lastSeenAt).getTime() < ONLINE_WINDOW_MS
}

// 워크스페이스-공유 러너(팀 자원) — admin 이 headless 러너(팀 빌드서버/CI)를 등록하면 이 워크스페이스 멤버
// 누구나 self:ws:<id> 로 타깃한다. 개인 러너(계정 페이지, 원클릭 데스크톱)와 달리 토큰을 1회 노출하고
// 서버에서 `everdict runner --pair` 로 붙인다. 등록/해제는 admin(settings:write) — 컨트롤플레인이 강제.
export function WorkspaceRunnersManager({
  runners,
  canWrite,
  githubApp,
  onOpenIntegrations,
}: {
  runners: RunnerMeta[]
  canWrite: boolean
  githubApp: GithubAppView // GitHub Actions 러너 등록 picker 의 대상 목록(설치 + 허용 레포) — 통합 탭과 같은 스냅샷
  onOpenIntegrations?: () => void // "GitHub App 설치/관리" CTA — 통합 탭으로 전환(같은 설정 페이지 안)
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

// 등록 모달 — 이름 + OS(선택) + capability 선택 후 등록. 등록되면 같은 모달이 토큰 1회 노출 + 접속 명령 단계로 전환.
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

  // 서버에서 붙일 때 실행할 명령 — apiUrl 이 있으면 넣어 보여준다(비밀 아님).
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

// GHE host 표시는 URL 스킴을 뗀 호스트명만(github.com 은 무표기) — picker 행 배지용.
const hostLabel = (host: string) => host.replace(/^https?:\/\//, '').replace(/\/$/, '')

// picker 선택 좌표 — 같은 "owner/name"/org 가 github.com 과 GHE 양쪽에 있을 수 있어 host 까지가 식별자다.
interface SelectedTarget {
  name: string // repo 모드 = "owner/name", org 모드 = org(설치 account)
  host?: string // GHE 베이스 URL — 미지정 = github.com
}
const targetKey = (s: SelectedTarget) => `${s.host ?? 'github.com'}:${s.name}`

// GitHub Actions 러너 자가등록 모달 — 워크스페이스 GitHub App 설치를 전제로, 설치가 허용한 레포/조직에서 대상을
// 고른다(raw 입력 없음; App 미설치면 통합 탭 설치 CTA). 생성되면 빌드 서버에서 실행할 설치 스크립트(GitHub 러너 +
// Everdict 러너)와 워크플로 힌트(runs-on 라벨 + run-eval runtime)를 1회 노출한다.
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
  // repo picker 행 — 각 설치의 허용 레포를 합친다(GHE 레포는 host 를 실어 옴). 조회 실패 설치는 경고로만.
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

  // "App 설치/저장소 확장" — 통합 탭으로 전환(모달은 닫는다).
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
        // App 미설치 — raw 입력으로 우회시키지 않고 설치를 요구한다(설치하면 레포/조직을 바로 고를 수 있다).
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
            {/* 대상: 레포 vs 조직(org — 그 org 의 모든 레포 공유) */}
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
              // 레포 picker — App 설치가 허용한 레포만(설치 시 고른 것). 검색은 레포명 + GHE 호스트명.
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
                                // GHE repo — 어느 인스턴스에서 온 것인지 호스트명으로 구분(github.com 은 무표기).
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
              // org picker — App 이 설치된 조직에서 고른다(그 org 의 모든 레포가 이 러너를 공유).
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
            {/* 원하는 레포/조직이 안 보이면 GitHub App 설치(허용 저장소)를 넓힌다 — 통합 탭에서. */}
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
