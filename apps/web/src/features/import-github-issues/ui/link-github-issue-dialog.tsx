'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Github, Loader2, Lock, Search } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { listGithubAppReposAction } from '@/features/manage-ci-links'
import type { RepoInfo } from '@/entities/ci-link'
import { useRefresh } from '@/shared/lib/use-refresh'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'
import { Label } from '@/shared/ui/input'
import { Switch } from '@/shared/ui/switch'
import { InfoTip } from '@/shared/ui/tooltip'

import {
  attachIssueGithubAction,
  listImportCandidatesAction,
  type GithubImportCandidate,
} from '../api/import-github-issues'

// The same coordinate the import picker keys by — one "owner/name" can exist on github.com and on a GHE host.
interface SelectedRepo {
  fullName: string
  host?: string
}

const repoKey = (r: SelectedRepo) => `${r.host ?? 'github.com'}:${r.fullName}`
const hostLabel = (host: string) => host.replace(/^https?:\/\//, '').replace(/\/$/, '')

const CANDIDATE_STATES = ['open', 'closed', 'all'] as const
type CandidateState = (typeof CANDIDATE_STATES)[number]

// Link an issue that ALREADY EXISTS here to an issue that already exists on GitHub — the counterpart to import,
// which files a new tracker issue instead. Until this existed the detail screen could DETACH a link it had no
// way to make, so an issue filed here could never be joined to the GitHub issue it was about.
//
// The candidate list is the import picker's (`/issues/import/candidates`): a repo's issues minus pull requests
// minus what this workspace already holds — which is exactly what may be linked, because one GitHub issue
// belongs to one record here. A picker rather than a number field for the reason the house rule gives: a typed
// number is a menu of guaranteed refusals, and only the control plane knows which numbers are free.
export function LinkGithubIssueDialog({
  open,
  onClose,
  workspace,
  issueId,
}: {
  open: boolean
  onClose: () => void
  workspace: string
  issueId: string
}) {
  const t = useTranslations('linkGithubIssue')
  const router = useRouter()
  const refresh = useRefresh()

  const [repos, setRepos] = useState<RepoInfo[]>()
  const [reposError, setReposError] = useState<string>()
  const [reposLoading, startReposLoad] = useTransition()
  const [repoQuery, setRepoQuery] = useState('')
  const [repository, setRepository] = useState<SelectedRepo>()

  const [state, setState] = useState<CandidateState>('open')
  const [candidates, setCandidates] = useState<GithubImportCandidate[]>()
  const [candidatesError, setCandidatesError] = useState<string>()
  const [candidatesLoading, startCandidatesLoad] = useTransition()
  const [selected, setSelected] = useState<number>()

  const [push, setPush] = useState(false)
  const [linkError, setLinkError] = useState<string>()
  // A plain pending flag, not a transition: a mutation held inside one stays entangled with the router and
  // commits whenever some unrelated update happens (`docs/web.md`, "A mutation must not hold the screen").
  const [linking, setLinking] = useState(false)

  useEffect(() => {
    if (!open) return
    setRepos(undefined)
    setReposError(undefined)
    setRepoQuery('')
    setRepository(undefined)
    setState('open')
    setCandidates(undefined)
    setCandidatesError(undefined)
    setSelected(undefined)
    setPush(false)
    setLinkError(undefined)
    startReposLoad(async () => {
      const r = await listGithubAppReposAction()
      if (r.ok && r.repos) setRepos(r.repos)
      else setReposError(r.error ?? t('reposLoadFailed'))
    })
    // Pinned to the snapshot at open time — react only to the open toggle.
  }, [open])

  // Candidates follow the repo AND the state filter; a re-query invalidates the choice, because an issue
  // number only means anything against the list it came from.
  useEffect(() => {
    if (!open || !repository) return
    const repo = repository
    setCandidates(undefined)
    setCandidatesError(undefined)
    setSelected(undefined)
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
  const noRepos = repos !== undefined && repos.length === 0

  function submit() {
    if (!repository || selected === undefined) return
    const repo = repository
    setLinkError(undefined)
    void (async () => {
      setLinking(true)
      try {
        const r = await attachIssueGithubAction(issueId, {
          repository: repo.fullName,
          ...(repo.host ? { host: repo.host } : {}),
          number: selected,
          sync: { pull: true, push },
        })
        if (!r.ok) {
          // Already linked here, or that remote taken by another issue — the control plane's own words, which
          // name WHICH issue holds it. A generic failure line would send the reader looking for it by hand.
          setLinkError(r.error ?? t('linkFailed'))
          return
        }
        // The link carries no content yet, by design: GitHub's title, description, labels and comments arrive
        // on the first Sync, which is the button the panel this reveals is built around.
        toast.success(t('linked', { repository: repo.fullName, number: selected }))
        refresh()
        onClose()
      } finally {
        setLinking(false)
      }
    })()
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="max-w-[640px]"
      labelledBy="issue-link-github-title"
    >
      <header className="border-b border-border px-5 py-4">
        <h2
          id="issue-link-github-title"
          className="flex items-center gap-2 text-[15px] font-[560] text-foreground"
        >
          <Github className="size-4 text-muted-foreground" />
          {t('title')}
          <InfoTip content={t('titleTip')} />
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{t('description')}</p>
      </header>

      {noRepos ? (
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
          <div className="max-h-[58vh] space-y-5 overflow-y-auto px-5 py-4">
            {/* 1. The repositories the workspace App installation can reach. */}
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
                  <div className="max-h-40 divide-y divide-border/70 overflow-y-auto rounded-md border bg-card">
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

            {/* 2. One issue — the repo's issues minus pull requests minus the ones already linked here. */}
            {repository && (
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label>{t('stepIssue')}</Label>
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
                  <Callout tone="muted" className="py-1.5" hint={t('noCandidatesHint')}>
                    {t('noCandidates')}
                  </Callout>
                ) : (
                  <div className="max-h-56 divide-y divide-border/70 overflow-y-auto rounded-md border bg-card">
                    {rows.map((c) => (
                      <button
                        key={c.number}
                        type="button"
                        onClick={() => setSelected(c.number)}
                        className={cn(
                          'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors',
                          selected === c.number ? 'bg-accent' : 'hover:bg-accent/60'
                        )}
                      >
                        <Check
                          className={cn(
                            'size-3.5 shrink-0 text-primary',
                            selected === c.number ? 'opacity-100' : 'opacity-0'
                          )}
                        />
                        <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
                          #{c.number}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">
                          {c.title}
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {t(`state.${c.state === 'closed' ? 'closed' : 'open'}`)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* 3. Push is the deliberate opt-in — it writes into somebody else's tracker. Pull stays on, which
                is what makes the GitHub copy the source of record for title/description/labels/comments. */}
            {repository && (
              <div className="flex items-start justify-between gap-4 rounded-md border bg-card px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-[12.5px] text-foreground">{t('pushLabel')}</p>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                    {t('pushHint')}
                  </p>
                </div>
                <Switch checked={push} onCheckedChange={setPush} aria-label={t('pushLabel')} />
              </div>
            )}

            {linkError && (
              <Callout tone="danger" className="py-1.5">
                {linkError}
              </Callout>
            )}
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">{t('pullNote')}</p>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="sm" variant="ghost" onClick={onClose} disabled={linking}>
                {t('close')}
              </Button>
              <Button size="sm" onClick={submit} disabled={linking || selected === undefined}>
                {linking && <Loader2 className="size-3.5 animate-spin" />}
                {t('link')}
              </Button>
            </div>
          </footer>
        </>
      )}
    </Dialog>
  )
}
