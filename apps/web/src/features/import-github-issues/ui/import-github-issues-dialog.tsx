'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Github, Loader2, Lock, Search } from 'lucide-react'
import { useTimeZone, useTranslations } from 'next-intl'

import { listGithubAppReposAction } from '@/features/manage-ci-links'
import type { RepoInfo } from '@/entities/ci-link'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Label } from '@/shared/ui/input'
import { InfoTip } from '@/shared/ui/tooltip'

import {
  importGithubIssuesAction,
  listImportCandidatesAction,
  type GithubImportCandidate,
  type GithubImportSkip,
} from '../api/import-github-issues'

// Picker selection coordinate — the same "owner/name" can exist on both github.com and a GHE host, so the
// identifier includes the host (same keying the CI repo picker uses).
interface SelectedRepo {
  fullName: string
  host?: string // GHE base URL — unset = github.com
}

const repoKey = (r: SelectedRepo) => `${r.host ?? 'github.com'}:${r.fullName}`
const hostLabel = (host: string) => host.replace(/^https?:\/\//, '').replace(/\/$/, '')

const CANDIDATE_STATES = ['open', 'closed', 'all'] as const
type CandidateState = (typeof CANDIDATE_STATES)[number]

// The import outcome, kept as its own step: skips are the normal case (re-running after a partial failure skips
// what already landed), and a count alone would hide WHICH numbers did not come across.
interface ImportOutcome {
  created: number
  skipped: GithubImportSkip[]
}

// GitHub issue import — pick a repo the workspace App installation can reach, choose issues, import them as
// tracker issues. Sync direction is decided here once: pull stays on (a copy that never refreshes is a stale
// copy) and push is the deliberate opt-in, because closing someone else's GitHub issue must never be a surprise.
export function ImportGithubIssuesDialog({
  open,
  onClose,
  workspace,
  projects,
}: {
  open: boolean
  onClose: () => void
  workspace: string
  projects: { id: string; name: string }[]
}) {
  const t = useTranslations('importGithubIssues')
  const timeZone = useTimeZone()
  const router = useRouter()

  const [repos, setRepos] = useState<RepoInfo[]>()
  const [reposError, setReposError] = useState<string>()
  const [reposLoading, startReposLoad] = useTransition()
  const [repoQuery, setRepoQuery] = useState('')
  const [repository, setRepository] = useState<SelectedRepo>()

  const [state, setState] = useState<CandidateState>('open')
  const [candidates, setCandidates] = useState<GithubImportCandidate[]>()
  const [candidatesError, setCandidatesError] = useState<string>()
  const [candidatesLoading, startCandidatesLoad] = useTransition()
  const [selected, setSelected] = useState<number[]>([])

  const [projectId, setProjectId] = useState('')
  const [push, setPush] = useState(false)
  const [importError, setImportError] = useState<string>()
  const [importing, startImport] = useTransition()
  const [outcome, setOutcome] = useState<ImportOutcome>()

  // Reset on each open + load the workspace App installation's repo list (only the repos chosen at install time).
  useEffect(() => {
    if (!open) return
    setRepos(undefined)
    setReposError(undefined)
    setRepoQuery('')
    setRepository(undefined)
    setState('open')
    setCandidates(undefined)
    setCandidatesError(undefined)
    setSelected([])
    setProjectId('')
    setPush(false)
    setImportError(undefined)
    setOutcome(undefined)
    startReposLoad(async () => {
      const r = await listGithubAppReposAction()
      if (r.ok && r.repos) setRepos(r.repos)
      else setReposError(r.error ?? t('reposLoadFailed'))
    })
    // Pinned to the snapshot at open time — react only to the open toggle.
  }, [open])

  // Candidates follow the repo AND the state filter; a re-query invalidates the selection because issue numbers
  // are only meaningful against the list they came from.
  useEffect(() => {
    if (!open || !repository) return
    const repo = repository
    setCandidates(undefined)
    setCandidatesError(undefined)
    setSelected([])
    startCandidatesLoad(async () => {
      const r = await listImportCandidatesAction({
        repository: repo.fullName,
        ...(repo.host ? { host: repo.host } : {}),
        state,
      })
      if (r.ok && r.candidates) setCandidates(r.candidates)
      else setCandidatesError(r.error ?? t('candidatesLoadFailed'))
    })
  }, [open, repository, state])

  const filteredRepos = (repos ?? []).filter((r) =>
    `${r.fullName} ${r.host ? hostLabel(r.host) : ''}`
      .toLowerCase()
      .includes(repoQuery.trim().toLowerCase())
  )
  const rows = candidates ?? []
  const allSelected = rows.length > 0 && selected.length === rows.length

  function toggleOne(number: number) {
    setSelected((prev) =>
      prev.includes(number) ? prev.filter((n) => n !== number) : [...prev, number]
    )
  }
  function toggleAll() {
    setSelected(allSelected ? [] : rows.map((r) => r.number))
  }

  function submit() {
    if (!repository || selected.length === 0) return
    const repo = repository
    setImportError(undefined)
    startImport(async () => {
      const r = await importGithubIssuesAction({
        repository: repo.fullName,
        ...(repo.host ? { host: repo.host } : {}),
        numbers: selected,
        ...(projectId ? { projectId } : {}),
        sync: { pull: true, push },
      })
      if (!r.ok || r.created === undefined || r.skipped === undefined) {
        setImportError(r.error ?? t('importFailed'))
        return
      }
      setOutcome({ created: r.created, skipped: r.skipped })
      router.refresh()
    })
  }

  const noRepos = repos !== undefined && repos.length === 0

  return (
    <Dialog open={open} onClose={onClose} className="max-w-[720px]" labelledBy="issue-import-title">
      <header className="border-b border-border px-5 py-4">
        <h2
          id="issue-import-title"
          className="flex items-center gap-2 text-[15px] font-[560] text-foreground"
        >
          <Github className="size-4 text-muted-foreground" />
          {t('title')}
          <InfoTip content={t('titleTip')} />
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{t('description')}</p>
      </header>

      {outcome ? (
        // Result step — the created count AND every skip, named. A silently swallowed skip reads as a successful
        // import of issues that are not there.
        <div className="space-y-4 px-5 py-5">
          <Callout tone="info">{t('importedCount', { count: outcome.created })}</Callout>
          {outcome.skipped.length > 0 && (
            <Callout tone="warning" hint={t('skippedHint')}>
              <p className="font-[510]">{t('skippedCount', { count: outcome.skipped.length })}</p>
              <ul className="mt-1.5 space-y-0.5">
                {outcome.skipped.map((s) => (
                  <li key={s.number} className="text-[12.5px]">
                    <span className="font-mono">#{s.number}</span>
                    {' — '}
                    {t(`skipReason.${s.reason}`)}
                  </li>
                ))}
              </ul>
            </Callout>
          )}
          <div className="flex justify-end">
            <Button size="sm" onClick={onClose}>
              {t('done')}
            </Button>
          </div>
        </div>
      ) : noRepos ? (
        // No accessible repos — the App is not installed (or was granted none), so point at where that is fixed.
        <div className="space-y-3 px-5 py-5">
          <Callout tone="info" hint={t('noReposHint')}>
            {t('noRepos')}
          </Callout>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              {t('close')}
            </Button>
            <Button
              size="sm"
              onClick={() => router.push(`/${encodeURIComponent(workspace)}/settings/integrations`)}
            >
              {t('openIntegrations')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="max-h-[62vh] space-y-5 overflow-y-auto px-5 py-4">
            {/* 1. Repo picker — what the workspace App installation can reach, narrowed client-side. */}
            <div className="space-y-1.5">
              <Label>{t('stepRepository')}</Label>
              {reposLoading || repos === undefined ? (
                <p className="text-[12px] text-muted-foreground">{t('reposLoading')}</p>
              ) : reposError ? (
                <Callout tone="danger" className="py-1.5">
                  {reposError}
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
                  <div className="max-h-44 divide-y divide-border/70 overflow-y-auto rounded-md border bg-card">
                    {filteredRepos.length === 0 ? (
                      <p className="px-3 py-4 text-center text-[12px] text-muted-foreground">
                        {t('noSearchResults')}
                      </p>
                    ) : (
                      filteredRepos.map((r) => {
                        const active =
                          repository !== undefined && repoKey(r) === repoKey(repository)
                        return (
                          <button
                            key={repoKey(r)}
                            type="button"
                            onClick={() =>
                              setRepository({
                                fullName: r.fullName,
                                ...(r.host ? { host: r.host } : {}),
                              })
                            }
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

            {/* 2. Candidates — the repo's issues minus pull requests minus what this workspace already holds. */}
            {repository && (
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label>{t('stepIssues')}</Label>
                  <div className="flex items-center gap-1.5">
                    {CANDIDATE_STATES.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setState(s)}
                        className={cn(
                          'rounded-full border px-2.5 py-0.5 text-[12px] transition-colors',
                          state === s
                            ? 'border-primary/40 bg-primary/10 text-foreground'
                            : 'border-border text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {t(`state.${s}`)}
                      </button>
                    ))}
                  </div>
                </div>
                {candidatesLoading || candidates === undefined ? (
                  <p className="text-[12px] text-muted-foreground">{t('candidatesLoading')}</p>
                ) : candidatesError ? (
                  <Callout tone="danger" className="py-1.5">
                    {candidatesError}
                  </Callout>
                ) : rows.length === 0 ? (
                  <Callout tone="muted" className="py-1.5">
                    {t('noCandidates')}
                  </Callout>
                ) : (
                  <div className="overflow-hidden rounded-md border bg-card">
                    <label className="flex cursor-pointer items-center gap-2.5 border-b border-border bg-muted/30 px-3 py-2">
                      <input
                        type="checkbox"
                        className="accent-primary"
                        checked={allSelected}
                        onChange={toggleAll}
                      />
                      <span className="text-[12px] font-[510] text-foreground">
                        {t('selectAll', { count: rows.length })}
                      </span>
                    </label>
                    <div className="max-h-64 divide-y divide-border/70 overflow-y-auto">
                      {rows.map((c) => (
                        <label
                          key={c.number}
                          className="flex cursor-pointer items-start gap-2.5 px-3 py-2 transition-colors hover:bg-accent/50"
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5 accent-primary"
                            checked={selected.includes(c.number)}
                            onChange={() => toggleOne(c.number)}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline gap-2">
                              <span className="shrink-0 font-mono text-[11.5px] text-faint">
                                #{c.number}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
                                {c.title}
                              </span>
                            </span>
                            <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
                              <Badge tone={c.state === 'closed' ? 'neutral' : 'success'}>
                                {t(`remoteState.${c.state === 'closed' ? 'closed' : 'open'}`)}
                              </Badge>
                              <span className="truncate">{c.author}</span>
                              {c.labels.map((label) => (
                                <Badge key={label} tone="outline">
                                  {label}
                                </Badge>
                              ))}
                              <time title={fmtDateTimeFull(c.updatedAt, { timeZone })}>
                                {fmtDateTime(c.updatedAt, timeZone)}
                              </time>
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 3. Where the imported issues land (optional) + the one sync decision that is not a default. */}
            {repository && rows.length > 0 && (
              <>
                {projects.length > 0 && (
                  <div className="space-y-1.5">
                    <Label htmlFor="issue-import-project">{t('stepProject')}</Label>
                    <Combobox
                      id="issue-import-project"
                      value={projectId}
                      onChange={setProjectId}
                      placeholder={t('projectNone')}
                      options={[
                        { value: '', label: t('projectNone') },
                        ...projects.map((p) => ({ value: p.id, label: p.name })),
                      ]}
                    />
                  </div>
                )}

                <div className="space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <Label>{t('stepSync')}</Label>
                    <InfoTip content={t('syncTip')} />
                  </div>
                  <div className="rounded-md border bg-card px-3 py-2.5">
                    <label className="flex cursor-pointer items-start gap-2.5">
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-primary"
                        checked={push}
                        onChange={(e) => setPush(e.target.checked)}
                      />
                      <span className="min-w-0">
                        <span className="block text-[13px] font-[510] text-foreground">
                          {t('pushLabel')}
                        </span>
                        <span className="mt-0.5 block text-[12px] leading-relaxed text-muted-foreground">
                          {t('pushExplain')}
                        </span>
                      </span>
                    </label>
                  </div>
                </div>
              </>
            )}

            {importError && (
              <Callout tone="danger" className="py-1.5">
                {importError}
              </Callout>
            )}
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3.5">
            <span className="text-[12px] text-faint">
              {repository ? (
                <>
                  <span className="font-mono text-muted-foreground">{repository.fullName}</span>
                  {repository.host && <> ({hostLabel(repository.host)})</>} ·{' '}
                  {t('selectedCount', { count: selected.length })}
                </>
              ) : (
                t('selectRepoHint')
              )}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                {t('cancel')}
              </Button>
              <Button size="sm" disabled={selected.length === 0 || importing} onClick={submit}>
                {importing ? <Loader2 className="size-3.5 animate-spin" /> : t('import')}
              </Button>
            </div>
          </footer>
        </>
      )}
    </Dialog>
  )
}
