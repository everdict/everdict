'use client'

import { useMemo, useState } from 'react'
import { ExternalLink, GitBranch, Tag } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import type { ProductService, ProductVersion } from '@/entities/product'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Card } from '@/shared/ui/card'

// The imported version ledger — per SERVICE. When one product assembles several services their versions move in separate streams, and mixed
// into one table in time order it cannot answer the actual question, "how far along is api right now"
// (you would have to scroll and filter names by eye). So the axis is the service, and time flows only inside it.
const COLLAPSED_ROWS = 6

interface LedgerGroup {
  service: string
  tracked?: ProductService
  versions: ProductVersion[]
}

export function ProductVersionLedger({
  services,
  versions,
}: {
  services: ProductService[]
  versions: ProductVersion[]
}) {
  const locale = useLocale()

  const groups = useMemo<LedgerGroup[]>(() => {
    const byService = new Map<string, ProductVersion[]>()
    for (const version of versions) {
      const rows = byService.get(version.service)
      if (rows) rows.push(version)
      else byService.set(version.service, [version])
    }
    // Declared services first, in declaration order — the ledger REFLECTS the product's composition rather than asserting an order of its own.
    // A name left in the ledger that is no longer declared stands separately at the end: it is the past of a service that was renamed or moved
    // repository, and hiding it quietly reads as "the import disappeared".
    const declared: LedgerGroup[] = services.map((service) => ({
      service: service.name,
      tracked: service,
      versions: byService.get(service.name) ?? [],
    }))
    const declaredNames = new Set(services.map((service) => service.name))
    const orphans: LedgerGroup[] = [...byService.entries()]
      .filter(([name]) => !declaredNames.has(name))
      .map(([name, rows]) => ({ service: name, versions: rows }))
    return [...declared, ...orphans]
  }, [services, versions])

  const dateLabel = useMemo(() => {
    const format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })
    return (iso: string) => format.format(new Date(iso))
  }, [locale])

  if (groups.length === 0) return null

  return (
    <div className="grid gap-2.5 @2xl:grid-cols-2 @5xl:grid-cols-3">
      {groups.map((group) => (
        <ServiceLedgerCard key={group.service} group={group} dateLabel={dateLabel} />
      ))}
    </div>
  )
}

function ServiceLedgerCard({
  group,
  dateLabel,
}: {
  group: LedgerGroup
  dateLabel: (iso: string) => string
}) {
  const t = useTranslations('productPage')
  const [expanded, setExpanded] = useState(false)
  // The ledger runs newest-published first. publishedAt is the REMOTE's (GitHub's) clock — the order is decided by when it went out in the world,
  // not by when we imported it.
  const ordered = [...group.versions].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
  const shown = expanded ? ordered : ordered.slice(0, COLLAPSED_ROWS)
  const hidden = ordered.length - shown.length

  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex min-w-0 items-center gap-1.5">
        <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-[13px] font-[510]">{group.service}</span>
        {group.tracked === undefined ? (
          <Badge tone="warning" title={t('untrackedHint')}>
            {t('untracked')}
          </Badge>
        ) : (
          group.tracked.tagPrefix && <Badge tone="neutral">{group.tracked.tagPrefix}*</Badge>
        )}
        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">
          {t('versionCount', { count: ordered.length })}
        </span>
      </div>
      {group.tracked && (
        <p className="-mt-1 truncate font-mono text-[11px] text-muted-foreground">
          {group.tracked.repository}
          {group.tracked.path !== undefined && (
            <span className="text-muted-foreground/70">/{group.tracked.path}</span>
          )}
        </p>
      )}

      {ordered.length === 0 ? (
        <p className="py-1 text-[12px] text-muted-foreground">{t('noVersionsYet')}</p>
      ) : (
        <ul className="space-y-0.5">
          {shown.map((version, index) => (
            <li
              key={version.id}
              className={cn(
                'flex items-baseline gap-2 rounded px-1 py-1 text-[12.5px]',
                // Only the newest row is emphasised — "how far along is this service right now" is this card's first question.
                index === 0 && !expanded ? 'bg-elevated' : null
              )}
            >
              <span className="min-w-0 flex-1 truncate font-mono">
                {version.url ? (
                  <a
                    href={version.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-baseline gap-1 hover:text-primary hover:underline"
                  >
                    {version.version}
                    <ExternalLink className="size-3 self-center opacity-60" aria-hidden />
                  </a>
                ) : (
                  version.version
                )}
              </span>
              {version.prerelease && <Badge tone="warning">{t('prerelease')}</Badge>}
              {/* The fact that a row came from a TAG rather than a release is kept — within the same ledger the weight of the evidence differs. */}
              {version.kind === 'tag' && (
                <Tag className="size-3 shrink-0 self-center text-muted-foreground" aria-hidden />
              )}
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                {dateLabel(version.publishedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="self-start text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('showAllVersions', { count: hidden })}
        </button>
      )}
    </Card>
  )
}
