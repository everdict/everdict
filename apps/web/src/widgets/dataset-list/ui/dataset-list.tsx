'use client'

import { useMemo } from 'react'
import { Boxes, Clock, Database, Waypoints } from 'lucide-react'
import { useTimeZone, useTranslations } from 'next-intl'

import {
  DATASET_FACETS,
  DATASET_GROUPINGS,
  DATASET_ORDERS,
  datasetListSpec,
  type DatasetSummary,
} from '@/entities/dataset'
import type { DatasetRelation } from '@/shared/lib/dataset-relations'
import { fmtDateTime, fmtDateTimeFull, fmtSubject } from '@/shared/lib/format'
import { applyListView } from '@/shared/lib/list-view'
import type { ListViewScope } from '@/shared/lib/load-list-view'
import { sortSemverDesc } from '@/shared/lib/semver'
import { useListView } from '@/shared/lib/use-list-view'
import { cn } from '@/shared/lib/utils'
import { UserAvatar } from '@/shared/ui/avatar'
import { EmptyState } from '@/shared/ui/empty-state'
import { Link } from '@/shared/ui/link'
import { facetOptionsOf, ListSection, ListToolbar, type FacetSpec } from '@/shared/ui/list-toolbar'
import { Score } from '@/shared/ui/score'
import { StatCard } from '@/shared/ui/stat-card'

type Author = { name: string; avatarUrl?: string }

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
  scope,
}: {
  workspace: string
  datasets: DatasetSummary[]
  relations: Record<string, DatasetRelation>
  authors: Record<string, Author>
  scope: ListViewScope
}) {
  const t = useTranslations('datasetList')
  const list = useTranslations('listView')
  const timeZone = useTimeZone()

  const view = useListView({
    basePath: scope.basePath,
    viewKey: scope.viewKey,
    facets: DATASET_FACETS,
    initialFilters: scope.filters,
    initialSearch: scope.search,
    initialDisplay: scope.display,
  })

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

  const creatorName = (subject: string): string => authors[subject]?.name ?? fmtSubject(subject)

  const facets = useMemo((): FacetSpec[] => {
    const of = (facet: string, labelOf: (value: string) => string, unset?: string) => ({
      key: facet,
      label: list(`facet.${facet}`),
      options: facetOptionsOf(
        datasets,
        (d) => datasetListSpec.facetValues(d, facet),
        labelOf,
        unset
      ),
    })
    return [
      of('creator', creatorName, list('unset.creator')),
      of('tag', (value) => value, list('unset.tag')),
    ].filter((facet) => facet.options.length > 0)
  }, [datasets, list, authors])

  const { total, groups } = useMemo(
    () =>
      applyListView(
        datasets,
        { filters: view.filters, search: view.search, display: view.display },
        datasetListSpec
      ),
    [datasets, view.filters, view.search, view.display]
  )

  function groupLabel(key: string | null): string {
    if (key === null) return list(`unset.${view.display.grouping}`)
    if (view.display.grouping === 'creator') return creatorName(key)
    return key
  }

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

      <ListToolbar
        search={view.search}
        onSearch={view.setSearch}
        facets={facets}
        filters={view.filters}
        onToggleFilter={view.toggleFilter}
        onClearFilters={view.clearFilters}
        total={total}
        groupings={DATASET_GROUPINGS}
        orders={DATASET_ORDERS}
        display={view.display}
        onDisplay={view.setDisplay}
      />

      {total === 0 ? (
        <EmptyState
          icon={<Database />}
          title={list('emptyFilteredTitle')}
          hint={list('emptyFilteredHint')}
        />
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <ListSection
              key={group.key ?? 'unset'}
              grouped={view.display.grouping !== 'none'}
              label={groupLabel(group.key)}
              count={group.items.length}
            >
              {group.items.map((d) => {
                const latest = d.latestVersion ?? sortSemverDesc(d.versions)[0]
                const rel = relations[d.id]
                const author = authorInfo(d)
                return (
                  <Link
                    key={d.id}
                    href={`/${workspace}/dataset/${encodeURIComponent(d.id)}`}
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
                                <span className="text-[10.5px] text-faint">
                                  +{d.tags.length - 4}
                                </span>
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
                        <span className="tabular-nums text-muted-foreground">
                          {d.caseCount ?? 0}
                        </span>
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
                          title={t('lastRunAt', {
                            at: fmtDateTimeFull(rel.lastRunAt, { timeZone }),
                          })}
                        >
                          <Clock className="size-3.5" />
                          {fmtDateTime(rel.lastRunAt, timeZone)}
                        </span>
                      )}
                    </div>
                  </Link>
                )
              })}
            </ListSection>
          ))}
        </div>
      )}
    </div>
  )
}
