'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { Boxes, Clock, Database, Search, Waypoints } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { DatasetSummary } from '@/entities/dataset'
import type { DatasetRelation } from '@/shared/lib/dataset-relations'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { sortSemverDesc } from '@/shared/lib/semver'
import { usePersistentFilters } from '@/shared/lib/use-persistent-filters'
import { cn } from '@/shared/lib/utils'
import { UserAvatar } from '@/shared/ui/avatar'
import { Combobox } from '@/shared/ui/combobox'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input } from '@/shared/ui/input'
import { ResetFiltersButton } from '@/shared/ui/reset-filters-button'
import { Score } from '@/shared/ui/score'
import { StatCard } from '@/shared/ui/stat-card'

type Sort = 'name' | 'updated' | 'cases'
type Author = { name: string; avatarUrl?: string }

// Filter defaults that persist across page navigation (query, sort, tags, creator).
const FILTER_DEFAULTS = { query: '', sort: 'name' as Sort, category: '', user: '' }

const STATUS_KEY: Record<string, string> = {
  succeeded: 'statusSucceeded',
  failed: 'statusFailed',
  running: 'statusRunning',
  queued: 'statusQueued',
}

// Latest run result — score (pass rate/mean) if succeeded, otherwise the status label. Dash if there's no run history.
function LatestResult({ rel }: { rel?: DatasetRelation }) {
  const t = useTranslations('datasetList')
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

export function DatasetList({
  workspace,
  datasets,
  relations,
  authors,
}: {
  workspace: string
  datasets: DatasetSummary[]
  relations: Record<string, DatasetRelation>
  authors: Record<string, Author>
}) {
  const t = useTranslations('datasetList')
  const sorts: { value: Sort; label: string }[] = [
    { value: 'name', label: t('sortName') },
    { value: 'updated', label: t('sortUpdated') },
    { value: 'cases', label: t('sortCases') },
  ]
  // Filter/search state is remembered per workspace (persists across navigation) — show the reset button when dirty.
  const { values, set, reset, dirty } = usePersistentFilters(
    `datasets:${workspace}`,
    FILTER_DEFAULTS
  )
  const { query, sort, category, user } = values

  const totalCases = datasets.reduce((n, d) => n + (d.caseCount ?? 0), 0)
  const tagCount = useMemo(() => new Set(datasets.flatMap((d) => d.tags)).size, [datasets])
  const ranCount = datasets.filter((d) => relations[d.id]?.lastStatus).length

  // Creator info — shown when createdBy is present (members profile if available). Otherwise (seed, etc.) '—'.
  function authorInfo(d: DatasetSummary): { name: string; avatarUrl?: string; known: boolean } {
    if (d.createdBy) {
      const a = authors[d.createdBy]
      return {
        name: a?.name ?? fmtSubject(d.createdBy),
        ...(a?.avatarUrl ? { avatarUrl: a.avatarUrl } : {}),
        known: true,
      }
    }
    return { name: '—', known: false }
  }

  // Filter dropdown options — category (tags across all datasets) · user (registrant).
  const categoryOptions = useMemo(() => {
    const s = new Set<string>()
    for (const d of datasets) for (const t of d.tags) s.add(t)
    return [
      { value: '', label: t('allCategories') },
      ...[...s].sort().map((tag) => ({ value: tag, label: tag })),
    ]
  }, [datasets, t])

  const userOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const d of datasets) {
      if (d.createdBy) m.set(d.createdBy, authors[d.createdBy]?.name ?? fmtSubject(d.createdBy))
    }
    return [
      { value: '', label: t('allUsers') },
      ...[...m.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([sub, name]) => ({ value: sub, label: name })),
    ]
  }, [datasets, authors, t])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = datasets.filter((d) => {
      if (category && !d.tags.includes(category)) return false
      if (user && d.createdBy !== user) return false
      if (!q) return true
      const hay = [d.id, d.description ?? '', ...d.tags, ...(relations[d.id]?.harnesses ?? [])]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
    const by: Record<Sort, (a: DatasetSummary, b: DatasetSummary) => number> = {
      name: (a, b) => a.id.localeCompare(b.id),
      updated: (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
      cases: (a, b) => (b.caseCount ?? 0) - (a.caseCount ?? 0),
    }
    return [...matched].sort(by[sort])
  }, [datasets, relations, query, sort, category, user])

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label={t('statDatasets')} value={datasets.length} />
        <StatCard label={t('statTotalCases')} value={totalCases} />
        <StatCard label={t('statCategories')} value={tagCount} />
        <StatCard
          label={t('statRan')}
          value={ranCount}
          tone={ranCount > 0 ? 'primary' : 'default'}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => set('query', e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="pl-8"
            aria-label={t('searchAria')}
          />
        </div>
        <Combobox
          options={categoryOptions}
          value={category}
          onChange={(v) => set('category', v)}
          placeholder={t('categoryPlaceholder')}
          className="w-[150px]"
        />
        {userOptions.length > 1 && (
          <Combobox
            options={userOptions}
            value={user}
            onChange={(v) => set('user', v)}
            placeholder={t('userPlaceholder')}
            className="w-[150px]"
          />
        )}
        <Combobox
          options={sorts.map((s) => ({ value: s.value, label: s.label }))}
          value={sort}
          onChange={(v) => set('sort', v as Sort)}
          className="w-[130px]"
          align="end"
          aria-label={t('sortAria')}
        />
        {dirty && <ResetFiltersButton onClick={reset} />}
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={<Search />} title={t('emptyTitle')} hint={t('emptyHint')} />
      ) : (
        <div className="space-y-2">
          {visible.map((d) => {
            const latest = d.latestVersion ?? sortSemverDesc(d.versions)[0]
            const rel = relations[d.id]
            const author = authorInfo(d)
            return (
              <Link
                key={d.id}
                href={`/${workspace}/datasets/${encodeURIComponent(d.id)}`}
                className="group block rounded-lg border bg-card p-3.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-elevated text-muted-foreground ring-1 ring-inset ring-border group-hover:text-foreground">
                      <Database className="size-[18px]" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[13px] font-[560] text-foreground">
                          {d.id}
                        </span>
                        {latest && (
                          <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border">
                            v{latest}
                          </code>
                        )}
                        {d.versions.length > 1 && (
                          <span className="text-[11px] text-faint">
                            {t('moreVersions', { n: d.versions.length - 1 })}
                          </span>
                        )}
                      </div>
                      {d.description && (
                        <p className="line-clamp-1 text-[12.5px] text-muted-foreground">
                          {d.description}
                        </p>
                      )}
                      {d.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {d.tags.slice(0, 4).map((tag) => (
                            <span
                              key={tag}
                              className="rounded bg-muted/40 px-1.5 py-0.5 text-[10.5px] text-muted-foreground ring-1 ring-inset ring-border"
                            >
                              {tag}
                            </span>
                          ))}
                          {d.tags.length > 4 && (
                            <span className="text-[10.5px] text-faint">+{d.tags.length - 4}</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Creator — round thumbnail only, name on hover (card display standard) */}
                  {author.known && (
                    <UserAvatar
                      name={author.name}
                      url={author.avatarUrl}
                      label={t('creator')}
                      className="shrink-0"
                    />
                  )}
                </div>

                {/* Meta line — cases · related harnesses · latest run (result+time) */}
                <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-11 text-[11.5px] text-faint">
                  <span className="inline-flex items-center gap-1">
                    <Boxes className="size-3.5" />
                    {t('cases')}{' '}
                    <span className="tabular-nums text-muted-foreground">{d.caseCount ?? 0}</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Waypoints className="size-3.5" />
                    {rel && rel.harnesses.length > 0 ? (
                      <span className="inline-flex flex-wrap items-center gap-1">
                        {rel.harnesses.slice(0, 3).map((h) => (
                          <code
                            key={h}
                            className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10.5px] text-secondary-foreground"
                          >
                            {h}
                          </code>
                        ))}
                        {rel.harnesses.length > 3 && (
                          <span className="text-faint">+{rel.harnesses.length - 3}</span>
                        )}
                      </span>
                    ) : (
                      <span>{t('noHarness')}</span>
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
