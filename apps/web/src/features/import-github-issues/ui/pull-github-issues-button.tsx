'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronDown, Github, Loader2, RefreshCw } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { Dialog } from '@/shared/ui/dialog'
import { DropdownItem, DropdownMenu } from '@/shared/ui/dropdown-menu'

import { pullIssueRepositoryAction, type IssueSyncOutcome } from '../api/import-github-issues'

const hostLabel = (host: string) => host.replace(/^https?:\/\//, '').replace(/\/$/, '')

// One repository the workspace has pull-enabled copies from. Host is part of the identity: the same "owner/name"
// can exist on github.com and on a GHE instance, and they are different repos.
export interface SyncedRepository {
  repository: string
  host?: string
  issues: number
}

const repoKey = (r: SyncedRepository) => `${r.host ?? 'github.com'}:${r.repository}`

// The manual bulk pull. Everdict never sweeps on its own, so this button IS the refresh: one incremental list
// call per repo, then a per-issue apply whose failures are recorded per issue rather than failing the batch.
export function PullGithubIssuesButton({ repositories }: { repositories: SyncedRepository[] }) {
  const t = useTranslations('importGithubIssues')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [failures, setFailures] = useState<IssueSyncOutcome[]>()

  function pull(repo: SyncedRepository) {
    startTransition(async () => {
      const r = await pullIssueRepositoryAction({
        repository: repo.repository,
        ...(repo.host ? { host: repo.host } : {}),
      })
      if (!r.ok || !r.outcomes) {
        toast.error(r.error ?? t('pullFailed'))
        return
      }
      const changed = r.outcomes.filter((o) => o.changed).length
      // A per-issue error is news the summary must not absorb — the count says the batch finished, the dialog
      // says which issues did not.
      const errors = r.outcomes.filter((o) => o.error !== undefined)
      toast.success(t('pullDone', { changed, total: r.outcomes.length }))
      if (errors.length > 0) setFailures(errors)
      router.refresh()
    })
  }

  if (repositories.length === 0) return null
  const single = repositories.length === 1 ? repositories[0] : undefined

  return (
    <>
      {single ? (
        <Button variant="secondary" size="sm" disabled={pending} onClick={() => pull(single)}>
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {t('pull')}
        </Button>
      ) : (
        <DropdownMenu
          align="end"
          trigger={({ toggle, open }) => (
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              aria-expanded={open}
              onClick={toggle}
            >
              {pending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              {t('pull')}
              <ChevronDown className="size-3.5" />
            </Button>
          )}
        >
          {repositories.map((repo) => (
            <DropdownItem
              key={repoKey(repo)}
              icon={<Github className="size-3.5" />}
              trailing={<span className="text-[11px] tabular-nums text-faint">{repo.issues}</span>}
              onSelect={() => pull(repo)}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                {repo.repository}
                {repo.host && (
                  <span className="ml-1.5 text-muted-foreground">({hostLabel(repo.host)})</span>
                )}
              </span>
            </DropdownItem>
          ))}
        </DropdownMenu>
      )}

      <Dialog
        open={failures !== undefined}
        onClose={() => setFailures(undefined)}
        className="max-w-md"
      >
        <div className="space-y-4 p-5">
          <h2 className="text-[15px] font-[560] text-foreground">{t('pullErrorsTitle')}</h2>
          <Callout tone="danger" hint={t('pullErrorsHint')}>
            <ul className="space-y-1">
              {(failures ?? []).map((outcome) => (
                <li key={outcome.id} className="text-[12.5px]">
                  <span className="font-mono">#{outcome.number}</span>
                  {' — '}
                  {outcome.error}
                </li>
              ))}
            </ul>
          </Callout>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setFailures(undefined)}>
              {t('close')}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  )
}
