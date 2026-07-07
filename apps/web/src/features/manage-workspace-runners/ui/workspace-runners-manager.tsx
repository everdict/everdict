'use client'

import { useEffect, useState, useTransition } from 'react'
import { Check, Copy, Github, Server, Trash2 } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

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
// 서버에서 `assay runner --pair` 로 붙인다. 등록/해제는 admin(settings:write) — 컨트롤플레인이 강제.
export function WorkspaceRunnersManager({
  runners,
  canWrite,
}: {
  runners: RunnerMeta[]
  canWrite: boolean
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
      {canWrite && <GithubInstallDialog open={githubOpen} onClose={() => setGithubOpen(false)} />}
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
    ? `assay runner --pair --token ${issued.token}${issued.apiUrl ? ` --api-url ${issued.apiUrl}` : ''}`
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

// GitHub Actions 러너 자가등록 모달 — 내 GitHub 연결 + repo 선택 후 생성. 생성되면 빌드 서버에서 실행할 설치
// 스크립트(GitHub 러너 + Assay 러너)와 워크플로 힌트(runs-on 라벨 + run-eval runtime)를 1회 노출한다.
function GithubInstallDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations('manageWorkspaceRunners')
  const locale = useLocale()
  const [mode, setMode] = useState<'repo' | 'org'>('repo')
  const [repository, setRepository] = useState('')
  const [org, setOrg] = useState('')
  const [runnerGroup, setRunnerGroup] = useState('')
  const [result, setResult] = useState<GithubRunnerInstall>()
  const [copied, setCopied] = useState<'script' | 'hint'>()
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    if (!open) return
    setMode('repo')
    setRepository('')
    setOrg('')
    setRunnerGroup('')
    setResult(undefined)
    setCopied(undefined)
    setError(undefined)
  }, [open])

  function onGenerate() {
    setError(undefined)
    if (mode === 'repo' && !/^[^/\s]+\/[^/\s]+$/.test(repository.trim())) {
      setError(t('repoInvalid'))
      return
    }
    if (mode === 'org' && !/^[^/\s]+$/.test(org.trim())) {
      setError(t('orgInvalid'))
      return
    }
    startTransition(async () => {
      const r = await githubInstallRunnerAction(
        mode === 'org' ? { org, ...(runnerGroup.trim() ? { runnerGroup } : {}) } : { repository }
      )
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
          <div className="space-y-4 px-5 py-4">
            <p className="text-[12px] text-faint">{t('githubAppHint')}</p>
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
              <div className="space-y-1.5">
                <Label htmlFor="gh-repo">{t('repo')}</Label>
                <Input
                  id="gh-repo"
                  value={repository}
                  onChange={(e) => setRepository(e.target.value)}
                  placeholder={t('repoPlaceholder')}
                  autoFocus
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="gh-org">{t('org')}</Label>
                <Input
                  id="gh-org"
                  value={org}
                  onChange={(e) => setOrg(e.target.value)}
                  placeholder={t('orgPlaceholder')}
                  autoFocus
                />
                <p className="text-[12px] text-faint">{t('orgShared')}</p>
                <Input
                  value={runnerGroup}
                  onChange={(e) => setRunnerGroup(e.target.value)}
                  placeholder={t('runnerGroupPlaceholder')}
                />
              </div>
            )}
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
            <Button size="sm" onClick={onGenerate} disabled={pending}>
              {pending ? t('generating') : t('generateScript')}
            </Button>
          </footer>
        </>
      )}
    </Dialog>
  )
}
