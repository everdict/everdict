'use client'

import { useMemo, useState, useTransition } from 'react'
import { GitBranch, Plus } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { CiLink } from '@/entities/ci-link'
import type { HarnessKind } from '@/entities/harness'
import { fmtSubject } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'

import { deleteCiLinkAction } from '../api/manage-ci-links'
import { ConnectRepoDialog, hostLabel } from './connect-repo-dialog'
import { SetupPrButton } from './setup-pr-button'

// kind → the build slot candidates this harness exposes to CI. service = service names, command = image, process = none.
function slotChoicesFor(kind: HarnessKind, serviceNames: string[]): string[] {
  if (kind === 'service') return serviceNames
  if (kind === 'command') return ['image']
  return []
}

// Link identity key — the same "owner/name" can be linked on both github.com and GHE, so include the host.
const linkKey = (l: Pick<CiLink, 'repository' | 'host'>) =>
  `${l.host ?? 'github.com'}:${l.repository}`

// Harness detail "CI integration" panel — the repo links connected to this harness + "Connect GitHub repo" (zero-input) + setup PR/unlink.
// Read is viewer+, save/unlink is admin (enforced by the control plane). A link's existence grants that repo's keyless CI trust.
export function CiLinkPanel({
  harnessId,
  kind,
  serviceNames,
  datasets,
  initialLinks,
  canWrite,
  workspace,
}: {
  harnessId: string
  kind: HarnessKind
  serviceNames: string[]
  datasets: string[]
  initialLinks: CiLink[] // links matched to this harness (filtered on the server)
  canWrite: boolean
  workspace: string
}) {
  const t = useTranslations('manageCiLinks')
  const [links, setLinks] = useState<CiLink[]>(initialLinks)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [confirmRepo, setConfirmRepo] = useState<string>()
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  const slotChoices = useMemo(() => slotChoicesFor(kind, serviceNames), [kind, serviceNames])

  // Dialog/delete return the workspace's full link set — pick just this harness's into local state.
  function applyLinks(all: CiLink[]) {
    setLinks(all.filter((l) => l.harness === harnessId))
  }

  function onDelete(link: CiLink) {
    setError(undefined)
    startTransition(async () => {
      const r = await deleteCiLinkAction(link.repository, link.host)
      setConfirmRepo(undefined)
      if (r.ok && r.links) applyLinks(r.links)
      else setError(r.error ?? t('unlinkFailed'))
    })
  }

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-[15px] font-[560] tracking-[-0.01em] text-foreground">
            {t('panelTitle')}
          </h2>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            {t('panelDescription')}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="shrink-0"
          onClick={() => setDialogOpen(true)}
        >
          <Plus />
          {t('connectRepo')}
        </Button>
      </div>

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}

      {links.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-card/40 px-4 py-6 text-center">
          <p className="text-[13px] text-muted-foreground">{t('emptyTitle')}</p>
          <p className="mt-1 text-[12px] text-faint">
            {canWrite ? t('emptyHintWrite') : t('emptyHintRead')}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border/70 overflow-hidden rounded-lg border bg-card shadow-raise">
          {links.map((l) => {
            const slotNames = Object.keys(l.slots ?? {})
            return (
              <li key={linkKey(l)} className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-0.5 font-mono text-[12px] text-foreground">
                      <GitBranch className="size-3 text-muted-foreground/70" />
                      {l.repository}
                    </span>
                    {l.host && (
                      // GHE link — which instance, shown as a hostname badge (github.com is unmarked).
                      <span className="rounded border border-border bg-muted/40 px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">
                        {hostLabel(l.host)}
                      </span>
                    )}
                    {l.disabled && <Badge tone="warning">{t('disabled')}</Badge>}
                    {l.dataset && (
                      <span className="text-[11px] text-muted-foreground">
                        {t('datasetLabel')}{' '}
                        <span className="font-mono text-foreground/85">{l.dataset}</span>
                      </span>
                    )}
                    {/* PR evaluation trigger mode — the default (both) is unmarked, shown only when narrowed. */}
                    {l.trigger === 'auto' && (
                      <span className="text-[11px] text-muted-foreground">
                        {t('triggerAutoLabel')}
                      </span>
                    )}
                    {l.trigger === 'comment' && (
                      <span className="text-[11px] text-muted-foreground">
                        <span className="font-mono text-foreground/85">/evaluate</span>{' '}
                        {t('triggerCommentSuffix')}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <SetupPrButton repository={l.repository} host={l.host} onError={setError} />
                    {canWrite &&
                      (confirmRepo === linkKey(l) ? (
                        <span className="flex items-center gap-2">
                          <Button
                            variant="destructive"
                            size="xs"
                            disabled={pending}
                            onClick={() => onDelete(l)}
                          >
                            {t('unlinkConfirm')}
                          </Button>
                          <button
                            type="button"
                            className="text-[12px] text-muted-foreground hover:text-foreground"
                            onClick={() => setConfirmRepo(undefined)}
                          >
                            {t('cancel')}
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="text-[12px] font-[510] text-destructive hover:underline"
                          onClick={() => setConfirmRepo(linkKey(l))}
                        >
                          {t('unlink')}
                        </button>
                      ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {slotNames.length > 0 ? (
                    slotNames.map((name) => {
                      const path = l.slots?.[name]?.path
                      return (
                        <code
                          key={name}
                          className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]"
                        >
                          <span className="text-foreground/85">{name}</span>
                          {path && <span className="text-faint">· {path}</span>}
                        </code>
                      )
                    })
                  ) : (
                    <span className="text-[11px] text-faint">{t('noSlots')}</span>
                  )}
                  <span className="ml-1 text-[11px] text-faint">
                    {t('registeredBy', { who: fmtSubject(l.createdBy) })}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <ConnectRepoDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        harnessId={harnessId}
        kind={kind}
        slotChoices={slotChoices}
        datasets={datasets}
        workspace={workspace}
        canWrite={canWrite}
        onSaved={applyLinks}
      />
    </section>
  )
}
