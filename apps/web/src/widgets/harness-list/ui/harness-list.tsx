'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Boxes, Clock, Layers, Lock, Waypoints } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { Harness } from '@/entities/harness'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import type { HarnessRelation } from '@/shared/lib/harness-relations'
import { cn } from '@/shared/lib/utils'
import { UserAvatar } from '@/shared/ui/avatar'
import { Combobox } from '@/shared/ui/combobox'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input } from '@/shared/ui/input'
import { Score } from '@/shared/ui/score'
import { StatCard } from '@/shared/ui/stat-card'

type Sort = 'name' | 'updated' | 'versions'
type Author = { name: string; avatarUrl?: string }

const STATUS_KEY: Record<string, string> = {
  succeeded: 'statusSucceeded',
  failed: 'statusFailed',
  running: 'statusRunning',
  queued: 'statusQueued',
}

// Latest run result — score if succeeded, otherwise the status label. Dash if there's no run history.
function LatestResult({ rel }: { rel?: HarnessRelation }) {
  const t = useTranslations('harnessList')
  if (!rel || !rel.lastStatus) return <span className="text-faint">{t('noRun')}</span>
  if (rel.lastStatus === 'succeeded') {
    return <Score passRate={rel.lastPassRate} mean={rel.lastMean} />
  }
  const key = STATUS_KEY[rel.lastStatus]
  return (
    <span
      className={cn(rel.lastStatus === 'failed' ? 'text-destructive' : 'text-muted-foreground')}
    >
      {key ? t(key) : rel.lastStatus}
    </span>
  )
}

export function HarnessList({
  workspace,
  harnesses,
  relations,
  authors,
}: {
  workspace: string
  harnesses: Harness[]
  relations: Record<string, HarnessRelation>
  authors: Record<string, Author>
}) {
  const t = useTranslations('harnessList')
  const sorts: { value: Sort; label: string }[] = [
    { value: 'name', label: t('sortName') },
    { value: 'updated', label: t('sortUpdated') },
    { value: 'versions', label: t('sortVersions') },
  ]
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('name')
  const [category, setCategory] = useState('') // category filter
  const [user, setUser] = useState('') // registrant (createdBy) filter

  const catCount = useMemo(
    () => new Set(harnesses.map((h) => h.category).filter(Boolean)).size,
    [harnesses]
  )
  const ranCount = harnesses.filter((h) => relations[h.id]?.lastStatus).length

  function authorInfo(h: Harness): { name: string; avatarUrl?: string; known: boolean } {
    if (h.createdBy) {
      const a = authors[h.createdBy]
      return {
        name: a?.name ?? fmtSubject(h.createdBy),
        ...(a?.avatarUrl ? { avatarUrl: a.avatarUrl } : {}),
        known: true,
      }
    }
    return { name: '—', known: false }
  }

  const categoryOptions = useMemo(() => {
    const s = new Set<string>()
    for (const h of harnesses) if (h.category) s.add(h.category)
    return [
      { value: '', label: t('allCategories') },
      ...[...s].sort().map((c) => ({ value: c, label: c })),
    ]
  }, [harnesses, t])

  const userOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const h of harnesses) {
      if (h.createdBy) m.set(h.createdBy, authors[h.createdBy]?.name ?? fmtSubject(h.createdBy))
    }
    return [
      { value: '', label: t('allUsers') },
      ...[...m.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([sub, name]) => ({ value: sub, label: name })),
    ]
  }, [harnesses, authors, t])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = harnesses.filter((h) => {
      if (category && h.category !== category) return false
      if (user && h.createdBy !== user) return false
      if (!q) return true
      const hay = [h.id, h.category ?? '', h.kind ?? '', h.subtitle ?? ''].join(' ').toLowerCase()
      return hay.includes(q)
    })
    const by: Record<Sort, (a: Harness, b: Harness) => number> = {
      name: (a, b) => a.id.localeCompare(b.id),
      updated: (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
      versions: (a, b) =>
        (b.versionCount ?? b.versions.length) - (a.versionCount ?? a.versions.length),
    }
    return [...matched].sort(by[sort])
  }, [harnesses, query, sort, category, user])

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <StatCard label={t('statHarnesses')} value={harnesses.length} />
        <StatCard label={t('statCategories')} value={catCount} />
        <StatCard
          label={t('statRan')}
          value={ranCount}
          tone={ranCount > 0 ? 'primary' : 'default'}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[200px] flex-1">
          <Layers className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="pl-8"
            aria-label={t('searchAria')}
          />
        </div>
        <Combobox
          options={categoryOptions}
          value={category}
          onChange={setCategory}
          placeholder={t('categoryPlaceholder')}
          className="w-[150px]"
        />
        {userOptions.length > 1 && (
          <Combobox
            options={userOptions}
            value={user}
            onChange={setUser}
            placeholder={t('userPlaceholder')}
            className="w-[150px]"
          />
        )}
        <Combobox
          options={sorts.map((s) => ({ value: s.value, label: s.label }))}
          value={sort}
          onChange={(v) => setSort(v as Sort)}
          className="w-[130px]"
          align="end"
          aria-label={t('sortAria')}
        />
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={<Boxes />} title={t('emptyTitle')} hint={t('emptyHint')} />
      ) : (
        <div className="space-y-2">
          {visible.map((h) => {
            const latest = h.latestVersion ?? h.versions[h.versions.length - 1]
            const nver = h.versionCount ?? h.versions.length
            const rel = relations[h.id]
            const author = authorInfo(h)
            return (
              <Link
                key={h.id}
                href={`/${workspace}/harnesses/${encodeURIComponent(h.id)}`}
                className="group block rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border group-hover:text-foreground">
                      <Boxes className="size-[18px]" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[13px] font-[560] text-foreground">
                          {h.id}
                        </span>
                        {latest && (
                          <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border">
                            v{latest}
                          </code>
                        )}
                        {nver > 1 && (
                          <span className="text-[11px] text-faint">
                            {t('moreVersions', { n: nver - 1 })}
                          </span>
                        )}
                        {h.private && (
                          <span
                            title={t('privateTitle')}
                            className="inline-flex items-center gap-0.5 rounded bg-[var(--color-warning)]/10 px-1.5 py-0.5 text-[10.5px] font-[510] text-[var(--color-warning)] ring-1 ring-inset ring-[var(--color-warning)]/30"
                          >
                            <Lock className="size-2.5" /> {t('privateBadge')}
                          </span>
                        )}
                      </div>
                      {h.subtitle && (
                        <p className="line-clamp-1 font-mono text-[12px] text-muted-foreground">
                          {h.subtitle}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-1">
                        {h.category && (
                          <span className="rounded bg-muted/40 px-1.5 py-0.5 text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border">
                            {h.category}
                          </span>
                        )}
                        {h.kind && (
                          <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-secondary-foreground">
                            {h.kind}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  {author.known && (
                    <UserAvatar
                      name={author.name}
                      url={author.avatarUrl}
                      label={t('creator')}
                      className="shrink-0"
                    />
                  )}
                </div>

                {/* Meta line — versions · benchmarks run · latest result (+time) */}
                <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-11 text-[11.5px] text-faint">
                  <span className="inline-flex items-center gap-1">
                    <Layers className="size-3.5" />
                    {t('versions')}{' '}
                    <span className="tabular-nums text-muted-foreground">{nver}</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Waypoints className="size-3.5" />
                    {rel && rel.datasets.length > 0 ? (
                      <span className="inline-flex flex-wrap items-center gap-1">
                        {rel.datasets.slice(0, 3).map((d) => (
                          <code
                            key={d}
                            className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-secondary-foreground"
                          >
                            {d}
                          </code>
                        ))}
                        {rel.datasets.length > 3 && (
                          <span className="text-faint">+{rel.datasets.length - 3}</span>
                        )}
                      </span>
                    ) : (
                      <span>{t('noBenchmark')}</span>
                    )}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="text-faint">{t('latestResult')}</span>
                    <LatestResult rel={rel} />
                  </span>
                  {rel?.lastRunAt && (
                    <span
                      className="inline-flex items-center gap-1"
                      title={t('lastRunAt', { at: fmtDateTimeFull(rel.lastRunAt) })}
                    >
                      <Clock className="size-3.5" />
                      {fmtDateTime(rel.lastRunAt)}
                    </span>
                  )}
                </div>
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}
