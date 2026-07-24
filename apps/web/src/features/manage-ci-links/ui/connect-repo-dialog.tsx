'use client'

import { useEffect, useState, useTransition } from 'react'
import Link from 'next/link'
import { Check, GitBranch, Lock, Search } from 'lucide-react'
import { useTimeZone, useTranslations } from 'next-intl'

import type { CiLink, CiTrigger, RepoInfo } from '@/entities/ci-link'
import type { HarnessKind } from '@/entities/harness'
import type { RunnerMeta } from '@/entities/runner'
import { fmtDateTime, fmtDateTimeFull } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Combobox } from '@/shared/ui/combobox'
import { Dialog } from '@/shared/ui/dialog'
import { Input, Label } from '@/shared/ui/input'

import {
  listGithubAppReposAction,
  listSharedRunnersAction,
  upsertCiLinkAction,
} from '../api/manage-ci-links'
import { SetupPrButton } from './setup-pr-button'

interface SlotState {
  enabled: boolean
  path: string
}

// Picker selection coordinate — the same "owner/name" can exist on both github.com and GHE, so the identifier includes the host.
interface SelectedRepo {
  fullName: string
  host?: string // GHE base URL — unset = github.com
}

const repoKey = (r: SelectedRepo) => `${r.host ?? 'github.com'}:${r.fullName}`
// GHE host display is just the hostname with the URL scheme stripped — shared by picker rows and panel badges.
export const hostLabel = (host: string) => host.replace(/^https?:\/\//, '').replace(/\/$/, '')

// Slot initial values — command preselects image; a single service slot auto-selects; with several the user chooses.
function initSlots(slotChoices: string[], kind: HarnessKind): Record<string, SlotState> {
  const preselect = kind === 'command' || slotChoices.length === 1
  return Object.fromEntries(
    slotChoices.map((s) => [s, { enabled: preselect, path: '' }])
  ) as Record<string, SlotState>
}

// Shared runner readiness — CI workflows always run on self-hosted runners (D6), so we show pool status at connect time.
// unavailable = can't query (non-admin / query failure) — informational text only.
type RunnerCheck =
  | { state: 'loading' }
  | { state: 'ready'; runners: RunnerMeta[] }
  | { state: 'unavailable' }

// Online determination — a runner refreshes lastSeenAt on each long-poll lease (~25s), so within 90s it's online (same convention as the shared-runners tab).
const ONLINE_WINDOW_MS = 90_000
const isOnline = (lastSeenAt?: string) =>
  lastSeenAt !== undefined && Date.now() - new Date(lastSeenAt).getTime() < ONLINE_WINDOW_MS

// Repo↔harness connect dialog (zero-input) — pick repo → pick slots → dataset → save → setup PR.
// The repo list is what the workspace GitHub App installation can access (only those chosen at install time). Saving is admin only.
export function ConnectRepoDialog({
  open,
  onClose,
  harnessId,
  kind,
  slotChoices,
  datasets,
  workspace,
  canWrite,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  harnessId: string
  kind: HarnessKind
  slotChoices: string[] // service = service names, command = ['image'], process = []
  datasets: string[] // dataset id list
  workspace: string
  canWrite: boolean
  onSaved: (links: CiLink[]) => void
}) {
  const t = useTranslations('manageCiLinks')
  const timeZone = useTimeZone()
  const [repos, setRepos] = useState<RepoInfo[]>()
  const [reposError, setReposError] = useState<string>()
  const [reposLoading, startReposLoad] = useTransition()
  const [repoQuery, setRepoQuery] = useState('')
  const [repository, setRepository] = useState<SelectedRepo>()
  const [slots, setSlots] = useState<Record<string, SlotState>>(() => initSlots(slotChoices, kind))
  const [dataset, setDataset] = useState('')
  const [trigger, setTrigger] = useState<CiTrigger>('both')
  const [runsOn, setRunsOn] = useState('')
  const [runtime, setRuntime] = useState('')
  const [saveError, setSaveError] = useState<string>()
  const [saving, startSaving] = useTransition()
  const [savedRepo, setSavedRepo] = useState<SelectedRepo>() // repo saved successfully (transition to the setup-PR step)
  const [runnerCheck, setRunnerCheck] = useState<RunnerCheck>({ state: 'loading' })

  // Reset on each open + load the workspace App installation's repo list.
  useEffect(() => {
    if (!open) return
    setReposError(undefined)
    setRepoQuery('')
    setRepository(undefined)
    setSlots(initSlots(slotChoices, kind))
    setDataset('')
    setTrigger('both')
    setRunsOn('')
    setRuntime('')
    setSaveError(undefined)
    setSavedRepo(undefined)
    setRepos(undefined)
    setRunnerCheck(canWrite ? { state: 'loading' } : { state: 'unavailable' })
    startReposLoad(async () => {
      const r = await listGithubAppReposAction()
      if (r.ok && r.repos) setRepos(r.repos)
      else setReposError(r.error ?? t('reposLoadFailed'))
    })
    // Shared runner readiness — the query gate is admin (settings:write), so only when canWrite. Failure degrades to informational text.
    if (canWrite)
      void listSharedRunnersAction().then((r) =>
        setRunnerCheck(
          r.ok && r.runners ? { state: 'ready', runners: r.runners } : { state: 'unavailable' }
        )
      )
    // Slots/repo list are pinned to the snapshot at open time (react only to the open toggle).
  }, [open])

  // Search matches both the repo name and the GHE hostname (so you can narrow by host).
  const filteredRepos = (repos ?? []).filter((r) =>
    `${r.fullName} ${r.host ? hostLabel(r.host) : ''}`
      .toLowerCase()
      .includes(repoQuery.trim().toLowerCase())
  )
  const enabledSlots = Object.entries(slots).filter(([, s]) => s.enabled)

  function toggleSlot(name: string) {
    setSlots((prev) => {
      const cur = prev[name] ?? { enabled: false, path: '' }
      return { ...prev, [name]: { ...cur, enabled: !cur.enabled } }
    })
  }
  function setSlotPath(name: string, path: string) {
    setSlots((prev) => {
      const cur = prev[name] ?? { enabled: true, path: '' }
      return { ...prev, [name]: { ...cur, path } }
    })
  }

  function onSave() {
    if (!repository) return
    setSaveError(undefined)
    const slotPayload: Record<string, { path?: string }> = {}
    for (const [name, s] of enabledSlots)
      slotPayload[name] = s.path.trim() ? { path: s.path.trim() } : {}
    startSaving(async () => {
      const r = await upsertCiLinkAction({
        repository: repository.fullName,
        ...(repository.host ? { host: repository.host } : {}),
        harness: harnessId,
        ...(dataset ? { dataset } : {}),
        slots: slotPayload,
        ...(trigger !== 'both' ? { trigger } : {}), // unset = both is the contract — don't persist the default
        ...(runsOn.trim() ? { runsOn: runsOn.trim() } : {}),
        ...(runtime.trim() ? { runtime: runtime.trim() } : {}),
      })
      if (r.ok && r.links) {
        onSaved(r.links)
        setSavedRepo(repository)
      } else setSaveError(r.error ?? t('linkSaveFailed'))
    })
  }

  const noRepos = repos !== undefined && repos.length === 0

  return (
    <Dialog open={open} onClose={onClose} className="max-w-[560px]" labelledBy="ci-connect-title">
      <header className="border-b border-border px-5 py-4">
        <h2 id="ci-connect-title" className="text-[15px] font-[560] text-foreground">
          {t('connectRepo')}
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
          {t.rich('dialogDescription', {
            id: harnessId,
            code: (c) => <span className="font-mono">{c}</span>,
          })}
        </p>
      </header>

      {noRepos ? (
        // App not installed / no accessible repos — guide to installing the GitHub App under Settings → Integrations.
        <div className="space-y-3 px-5 py-5">
          <Callout tone="info">
            {t('noReposCallout')}
            <div className="mt-2">
              <Link
                href={`/${encodeURIComponent(workspace)}/settings/integrations`}
                className="text-[12px] font-[510] text-primary hover:underline"
              >
                {t('installGithubAppLink')}
              </Link>
            </div>
          </Callout>
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" onClick={onClose}>
              {t('close')}
            </Button>
          </div>
        </div>
      ) : savedRepo ? (
        // Save complete — setup-PR step.
        <div className="space-y-4 px-5 py-5">
          <Callout tone="info">
            {t.rich('connectedMessage', {
              repo: savedRepo.fullName,
              host: savedRepo.host ? ` (${hostLabel(savedRepo.host)})` : '',
              harness: harnessId,
              repoTag: (c) => <span className="font-mono text-foreground">{c}</span>,
              hostTag: (c) => <span className="font-mono text-muted-foreground">{c}</span>,
              harnessTag: (c) => <span className="font-mono text-foreground">{c}</span>,
            })}
          </Callout>
          <div className="flex items-center justify-between gap-3">
            <SetupPrButton
              repository={savedRepo.fullName}
              host={savedRepo.host}
              size="sm"
              onError={setSaveError}
            />
            <Button size="sm" onClick={onClose}>
              {t('done')}
            </Button>
          </div>
          {saveError && (
            <Callout tone="danger" className="py-1.5">
              {saveError}
            </Callout>
          )}
        </div>
      ) : (
        <>
          <div className="max-h-[62vh] space-y-5 overflow-y-auto px-5 py-4">
            {/* 1. Repo picker — repos the App installation can access, client-side search. */}
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
                  <div className="max-h-52 divide-y divide-border/70 overflow-y-auto rounded-md border bg-card">
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
                              // GHE repo — distinguish which instance it came from by hostname (github.com is unmarked).
                              <span className="shrink-0 rounded border border-border bg-muted/40 px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">
                                {hostLabel(r.host)}
                              </span>
                            )}
                            {r.private && (
                              <Lock className="size-3 shrink-0 text-muted-foreground/70" />
                            )}
                            {r.pushedAt && (
                              <time
                                className="shrink-0 font-mono text-[10.5px] text-faint"
                                title={fmtDateTimeFull(r.pushedAt, { timeZone })}
                              >
                                {fmtDateTime(r.pushedAt, timeZone)}
                              </time>
                            )}
                          </button>
                        )
                      })
                    )}
                  </div>
                </>
              )}
            </div>

            {/* 2. Slots — service = multi-select services (+path), command = image, process = none. */}
            {repository && (
              <div className="space-y-2">
                <Label>{t('stepBuildSlot')}</Label>
                {slotChoices.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">{t('noSlotsProcess')}</p>
                ) : (
                  <div className="space-y-1.5">
                    {slotChoices.map((name) => {
                      const s = slots[name] ?? { enabled: false, path: '' }
                      return (
                        <div key={name} className="rounded-md border bg-card px-3 py-2">
                          <label className="flex cursor-pointer items-center gap-2.5">
                            <input
                              type="checkbox"
                              className="accent-primary"
                              checked={s.enabled}
                              onChange={() => toggleSlot(name)}
                            />
                            <span className="font-mono text-[12px] font-[510] text-foreground">
                              {name}
                            </span>
                          </label>
                          {s.enabled && (
                            <div className="mt-2 pl-[26px]">
                              <Input
                                value={s.path}
                                placeholder={t('monorepoPathPlaceholder')}
                                onChange={(e) => setSlotPath(name, e.target.value)}
                                autoComplete="off"
                                spellCheck={false}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* 3. Dataset — the benchmark CI fires (optional). */}
            {repository && datasets.length > 0 && (
              <div className="space-y-1.5">
                <Label>{t('stepDataset')}</Label>
                <Combobox
                  options={[
                    { value: '', label: t('datasetNone'), hint: t('datasetNoneHint') },
                    ...datasets.map((d) => ({ value: d })),
                  ]}
                  value={dataset}
                  onChange={setDataset}
                  placeholder={t('datasetSelectPlaceholder')}
                />
                <p className="text-[12px] text-faint">{t('datasetHelp')}</p>
              </div>
            )}

            {/* 4. PR evaluation trigger mode — automatic / comment (/evaluate) / both. push (merge re-pin) always fires regardless of mode. */}
            {repository && (
              <div className="space-y-1.5">
                <Label>{t('stepTrigger')}</Label>
                <Combobox
                  options={[
                    { value: 'both', label: t('triggerBothLabel'), hint: t('triggerBothHint') },
                    { value: 'auto', label: t('triggerAutoOption'), hint: t('triggerAutoHint') },
                    {
                      value: 'comment',
                      label: t('triggerCommentLabel'),
                      hint: t('triggerCommentHint'),
                    },
                  ]}
                  value={trigger}
                  onChange={(v) => setTrigger(v === 'auto' || v === 'comment' ? v : 'both')}
                  placeholder={t('triggerPlaceholder')}
                />
                <p className="text-[12px] text-faint">
                  {t.rich('triggerHelp', {
                    code: (c) => <span className="font-mono">{c}</span>,
                  })}
                </p>
              </div>
            )}

            {/* 5. Execution runner — CI workflows always run on self-hosted runners (D6, reaching a private-network control plane). Default = shared runner pool. */}
            {repository && (
              <div className="space-y-1.5">
                <Label>{t('stepRunner')}</Label>
                {runnerCheck.state === 'loading' ? (
                  <p className="text-[12px] text-muted-foreground">{t('runnersLoading')}</p>
                ) : runnerCheck.state === 'ready' && runnerCheck.runners.length === 0 ? (
                  // Zero runners — the setup PR is blocked on the server (fail-closed), so guide the registration path first.
                  <Callout tone="warning" className="py-1.5">
                    {t('noRunnersCallout')}
                    <div className="mt-1.5">
                      <Link
                        href={`/${encodeURIComponent(workspace)}/runtimes`}
                        className="text-[12px] font-[510] text-primary hover:underline"
                      >
                        {t('registerRunnerLink')}
                      </Link>
                    </div>
                  </Callout>
                ) : runnerCheck.state === 'ready' ? (
                  <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                    <span
                      className="inline-block size-1.5 shrink-0 rounded-full bg-[var(--color-success)]"
                      aria-hidden
                    />
                    {t.rich('runnersReady', {
                      total: runnerCheck.runners.length,
                      online: runnerCheck.runners.filter((r) => isOnline(r.lastSeenAt)).length,
                      code: (c) => <span className="font-mono">{c}</span>,
                    })}
                  </p>
                ) : (
                  <p className="text-[12px] text-muted-foreground">{t('runnersUnavailable')}</p>
                )}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Input
                    value={runsOn}
                    onChange={(e) => setRunsOn(e.target.value)}
                    placeholder={t('runsOnPlaceholder')}
                  />
                  <Input
                    value={runtime}
                    onChange={(e) => setRuntime(e.target.value)}
                    placeholder={t('runtimePlaceholder')}
                  />
                </div>
                <p className="text-[12px] text-faint">
                  {t.rich('runnerHelp', {
                    code: (c) => <span className="font-mono">{c}</span>,
                  })}
                </p>
              </div>
            )}

            {!canWrite && (
              <Callout tone="warning" className="py-1.5">
                {t('saveAdminRequired')}
              </Callout>
            )}
            {saveError && (
              <Callout tone="danger" className="py-1.5">
                {saveError}
              </Callout>
            )}
          </div>

          <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3.5">
            <span className="text-[12px] text-faint">
              {repository ? (
                <>
                  <span className="font-mono text-muted-foreground">{repository.fullName}</span>
                  {repository.host && <> ({hostLabel(repository.host)})</>} ·{' '}
                  {t('slotCount', { count: enabledSlots.length })}
                </>
              ) : (
                t('selectRepoHint')
              )}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                {t('cancel')}
              </Button>
              <Button size="sm" disabled={!canWrite || !repository || saving} onClick={onSave}>
                <GitBranch />
                {saving ? t('saving') : t('saveLink')}
              </Button>
            </div>
          </footer>
        </>
      )}
    </Dialog>
  )
}
