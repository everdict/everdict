'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { GitBranch } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { CiLink } from '@/entities/ci-link'
import { fmtSubject } from '@/shared/lib/format'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { SettingsList, SettingsRow } from '@/shared/ui/settings-list'

import { deleteCiLinkAction } from '../api/manage-ci-links'
import { hostLabel } from './connect-repo-dialog'

// Link identity key — the same "owner/name" can be linked on both github.com and GHE, so include the host.
const linkKey = (l: Pick<CiLink, 'repository' | 'host'>) =>
  `${l.host ?? 'github.com'}:${l.repository}`

// Workspace-settings "CI integration" section — the list of all repo links in this workspace (repo↔harness slot = OIDC trust) + unlink (admin).
// A link's "existence" grants that repo's keyless CI (OIDC) trust, so this list is exactly the list of trust-granted repos.
export function CiLinksSettings({
  initialLinks,
  canWrite,
}: {
  initialLinks: CiLink[]
  canWrite: boolean
}) {
  const t = useTranslations('manageCiLinks')
  const { workspace } = useParams<{ workspace: string }>()
  const [links, setLinks] = useState<CiLink[]>(initialLinks)
  const [confirmRepo, setConfirmRepo] = useState<string>()
  const [error, setError] = useState<string>()
  const [pending, startTransition] = useTransition()

  function onDelete(link: CiLink) {
    setError(undefined)
    startTransition(async () => {
      const r = await deleteCiLinkAction(link.repository, link.host)
      setConfirmRepo(undefined)
      if (r.ok && r.links) setLinks(r.links)
      else setError(r.error ?? t('unlinkFailed'))
    })
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h3 className="text-[13px] font-[560] text-foreground">{t('panelTitle')}</h3>
        <p className="max-w-prose text-[13px] leading-relaxed text-muted-foreground">
          {t.rich('settingsDescription', {
            strong: (c) => <span className="font-[510]">{c}</span>,
          })}
        </p>
      </div>

      {error && (
        <Callout tone="danger" className="py-1.5">
          {error}
        </Callout>
      )}

      {links.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('settingsEmpty')}</p>
      ) : (
        <SettingsList>
          {links.map((l) => {
            const slotNames = Object.keys(l.slots ?? {})
            return (
              <SettingsRow
                key={linkKey(l)}
                label={
                  <span className="inline-flex items-center gap-1.5 font-mono">
                    <GitBranch className="size-3.5 text-muted-foreground/70" />
                    {l.repository}
                    {l.host && (
                      // GHE link — which instance, shown as a hostname badge (github.com is unmarked).
                      <span className="rounded border border-border bg-muted/40 px-1.5 py-px font-mono text-[10.5px] text-muted-foreground">
                        {hostLabel(l.host)}
                      </span>
                    )}
                    {l.disabled && <Badge tone="warning">{t('disabled')}</Badge>}
                  </span>
                }
                hint={
                  <span className="flex flex-wrap items-center gap-x-1.5">
                    <span>
                      {t('harnessLabel')}{' '}
                      <span className="font-mono text-foreground/80">{l.harness}</span>
                    </span>
                    {l.dataset && (
                      <span>
                        {t('datasetHint')}{' '}
                        <span className="font-mono text-foreground/80">{l.dataset}</span>
                      </span>
                    )}
                    <span>
                      {t('slotsHint', {
                        slots: slotNames.length > 0 ? slotNames.join(', ') : t('none'),
                      })}
                    </span>
                    <span>{t('registeredHint', { who: fmtSubject(l.createdBy) })}</span>
                  </span>
                }
              >
                <Link
                  href={`/${encodeURIComponent(workspace)}/harnesses/${encodeURIComponent(l.harness)}`}
                  className="text-[12px] font-[510] text-link hover:text-foreground"
                >
                  {t('harnessLink')}
                </Link>
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
              </SettingsRow>
            )
          })}
        </SettingsList>
      )}

      {!canWrite && links.length > 0 && (
        <p className="text-[12px] text-muted-foreground">{t('unlinkAdminRequired')}</p>
      )}
    </div>
  )
}
