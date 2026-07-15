'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import type { ScorecardRecord } from '@/entities/scorecard'
import {
  dayKeyOf,
  fmtDateHeading,
  fmtDateTime,
  fmtDateTimeFull,
  fmtSubject,
  fmtTimeOnly,
} from '@/shared/lib/format'
import { UserAvatar } from '@/shared/ui/avatar'
import { EntityRef, MetricChip, ModelChip, SubsetChip } from '@/shared/ui/chip'
import { Combobox } from '@/shared/ui/combobox'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input } from '@/shared/ui/input'
import { OriginChip } from '@/shared/ui/origin'
import { StatCard } from '@/shared/ui/stat-card'
import { StatusIcon } from '@/shared/ui/status-pill'

type Sort = 'recent' | 'name'
type Author = { name: string; avatarUrl?: string }

// Scorecard list — same pattern as the dataset list (search + Combobox filter + sort + runner avatar).
export function ScorecardList({
  workspace,
  scorecards,
  authors,
}: {
  workspace: string
  scorecards: ScorecardRecord[]
  authors: Record<string, Author>
}) {
  const t = useTranslations('scorecardList')
  const locale = useLocale()
  const sorts: { value: Sort; label: string }[] = [
    { value: 'recent', label: t('sortRecent') },
    { value: 'name', label: t('sortName') },
  ]
  const statusOptions = [
    { value: '', label: t('allStatuses') },
    { value: 'succeeded', label: t('statusSucceeded') },
    { value: 'running', label: t('statusRunning') },
    { value: 'queued', label: t('statusQueued') },
    { value: 'failed', label: t('statusFailed') },
    { value: 'superseded', label: t('statusSuperseded') },
    { value: 'cancelled', label: t('statusCancelled') },
  ]
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<Sort>('recent')
  const [dataset, setDataset] = useState('') // dataset filter ('' = all)
  const [harness, setHarness] = useState('') // harness filter ('' = all)
  const [status, setStatus] = useState('') // status filter ('' = all)
  const [user, setUser] = useState('') // runner (createdBy) filter ('' = all)

  const total = scorecards.length
  const succeeded = scorecards.filter((s) => s.status === 'succeeded').length
  const running = scorecards.filter((s) => s.status === 'running' || s.status === 'queued').length
  const failed = scorecards.filter((s) => s.status === 'failed').length

  // Runner info — shown if createdBy exists (members profile if available). Hidden if absent (legacy records / machine-fired).
  function authorInfo(s: ScorecardRecord): { name: string; avatarUrl?: string; known: boolean } {
    if (s.createdBy) {
      const a = authors[s.createdBy]
      return {
        name: a?.name ?? fmtSubject(s.createdBy),
        ...(a?.avatarUrl ? { avatarUrl: a.avatarUrl } : {}),
        known: true,
      }
    }
    return { name: '—', known: false }
  }

  // Filter dropdown options — dataset · harness · runner (derived from all scorecards).
  const datasetOptions = useMemo(() => {
    const s = new Set(scorecards.map((c) => c.dataset.id))
    return [
      { value: '', label: t('allDatasets') },
      ...[...s].sort().map((d) => ({ value: d, label: d })),
    ]
  }, [scorecards, t])

  const harnessOptions = useMemo(() => {
    const s = new Set(scorecards.map((c) => c.harness.id))
    return [
      { value: '', label: t('allHarnesses') },
      ...[...s].sort().map((h) => ({ value: h, label: h })),
    ]
  }, [scorecards, t])

  const userOptions = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of scorecards) {
      if (c.createdBy) m.set(c.createdBy, authors[c.createdBy]?.name ?? fmtSubject(c.createdBy))
    }
    return [
      { value: '', label: t('allUsers') },
      ...[...m.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([sub, name]) => ({ value: sub, label: name })),
    ]
  }, [scorecards, authors, t])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = scorecards.filter((s) => {
      if (dataset && s.dataset.id !== dataset) return false
      if (harness && s.harness.id !== harness) return false
      if (status && s.status !== status) return false
      if (user && s.createdBy !== user) return false
      if (!q) return true
      const hay = [
        s.dataset.id,
        s.harness.id,
        s.models?.primary ?? '',
        ...(s.judgeModels ?? []),
        s.origin?.source ?? '',
        s.createdBy ? (authors[s.createdBy]?.name ?? s.createdBy) : '',
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
    const by: Record<Sort, (a: ScorecardRecord, b: ScorecardRecord) => number> = {
      recent: (a, b) => b.createdAt.localeCompare(a.createdAt),
      name: (a, b) =>
        a.dataset.id.localeCompare(b.dataset.id) || a.harness.id.localeCompare(b.harness.id),
    }
    return [...matched].sort(by[sort])
  }, [scorecards, authors, query, sort, dataset, harness, status, user])

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label={t('statTotal')} value={total} />
        <StatCard
          label={t('statSucceeded')}
          value={succeeded}
          tone={succeeded > 0 ? 'success' : 'default'}
        />
        <StatCard
          label={t('statRunning')}
          value={running}
          tone={running > 0 ? 'primary' : 'default'}
        />
        <StatCard label={t('statFailed')} value={failed} tone={failed > 0 ? 'danger' : 'default'} />
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="pl-8"
            aria-label={t('searchAria')}
          />
        </div>
        <Combobox
          options={datasetOptions}
          value={dataset}
          onChange={setDataset}
          placeholder={t('datasetPlaceholder')}
          className="w-[150px]"
        />
        <Combobox
          options={harnessOptions}
          value={harness}
          onChange={setHarness}
          placeholder={t('harnessPlaceholder')}
          className="w-[150px]"
        />
        <Combobox
          options={statusOptions}
          value={status}
          onChange={setStatus}
          placeholder={t('statusPlaceholder')}
          className="w-[130px]"
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
        <EmptyState icon={<Search />} title={t('emptyTitle')} hint={t('emptyHint')} />
      ) : (
        <div className="space-y-4">
          {(sort === 'recent'
            ? // recent sort: grouped by date (header = today/yesterday/date, rows show time only)
              [
                ...visible
                  .reduce((m, s) => {
                    const k = dayKeyOf(s.createdAt)
                    const g = m.get(k)
                    if (g) g.push(s)
                    else m.set(k, [s])
                    return m
                  }, new Map<string, ScorecardRecord[]>())
                  .entries(),
              ]
            : ([['', visible]] as Array<[string, ScorecardRecord[]]>)
          ).map(([day, items]) => (
            <section key={day || 'all'} className="space-y-2">
              {day && items[0] && (
                <h4 className="px-0.5 text-[11.5px] font-[560] uppercase tracking-wide text-faint">
                  {fmtDateHeading(items[0].createdAt, locale)}
                </h4>
              )}
              {items.map((s, i) => {
                const author = authorInfo(s)
                const metrics = s.summary ?? []
                const shownMetrics = metrics.slice(0, 3) // keep the card format — top 3 only, the rest as +N
                const judges = s.judgeModels ?? []
                return (
                  // Fixed-format card — 3 lines (dataset/harness/aggregate), no arrow·inline name. Status is a color icon only.
                  <Link
                    key={s.id}
                    href={`/${workspace}/scorecards/${encodeURIComponent(s.id)}`}
                    style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}
                    className="rise flex items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 shadow-raise transition-colors hover:border-border-strong hover:bg-elevated"
                  >
                    {/* Left: 3 lines — ① dataset ② harness (+model·source) ③ aggregate chips. Each one line, truncated (no wrap). */}
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[13px] font-[510]">
                        <span className="truncate">
                          <EntityRef id={s.dataset.id} version={s.dataset.version} kind="dataset" />
                        </span>
                        {s.subset ? (
                          <span className="shrink-0">
                            <SubsetChip selected={s.subset.selected} total={s.subset.total} />
                          </span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[13px] font-[510]">
                        <span className="truncate">
                          <EntityRef id={s.harness.id} version={s.harness.version} kind="harness" />
                        </span>
                        {s.models?.primary ? (
                          <span className="hidden shrink-0 sm:inline-flex">
                            <ModelChip>{s.models.primary}</ModelChip>
                          </span>
                        ) : null}
                        {s.origin ? (
                          <span className="hidden shrink-0 md:inline-flex">
                            <OriginChip origin={s.origin} />
                          </span>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-1 overflow-hidden whitespace-nowrap">
                        {shownMetrics.length > 0 ? (
                          shownMetrics.map((m) => (
                            <span key={m.metric} className="shrink-0">
                              <MetricChip
                                metric={m.metric}
                                mean={m.mean}
                                passRate={m.passRate}
                                siblings={metrics.map((x) => x.metric)}
                              />
                            </span>
                          ))
                        ) : (
                          <span className="text-[11px] text-faint">
                            {s.status === 'failed' ? t('noAggregate') : t('pendingAggregate')}
                          </span>
                        )}
                        {metrics.length > shownMetrics.length && (
                          <span className="shrink-0 text-[11px] text-faint">
                            +{metrics.length - shownMetrics.length}
                          </span>
                        )}
                        {judges.length > 0 && (
                          <span className="ml-1 hidden shrink-0 items-center gap-1 lg:inline-flex">
                            <span className="text-[10px] uppercase tracking-wide text-faint">
                              judge
                            </span>
                            <ModelChip muted>{judges[0]}</ModelChip>
                            {judges.length > 1 && (
                              <span className="text-[11px] text-faint">+{judges.length - 1}</span>
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                    {/* Right: fixed slots — runner (thumbnail) · time (grouped = time only) · status (color icon). */}
                    <div className="flex shrink-0 items-center gap-2.5">
                      <span className="flex w-6 justify-center">
                        {author.known && (
                          <UserAvatar
                            name={author.name}
                            url={author.avatarUrl}
                            label={t('runnerLabel')}
                          />
                        )}
                      </span>
                      <time
                        className={
                          sort === 'recent'
                            ? 'hidden w-[44px] text-right font-mono text-[11px] text-muted-foreground sm:block'
                            : 'hidden w-[84px] text-right font-mono text-[11px] text-muted-foreground sm:block'
                        }
                        title={fmtDateTimeFull(s.createdAt)}
                      >
                        {sort === 'recent' ? fmtTimeOnly(s.createdAt) : fmtDateTime(s.createdAt)}
                      </time>
                      <span className="flex w-5 justify-end">
                        <StatusIcon status={s.status} />
                      </span>
                    </div>
                  </Link>
                )
              })}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
