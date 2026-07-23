'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { Check, Search, Telescope, Trash2 } from 'lucide-react'
import { useLocale, useTimeZone, useTranslations } from 'next-intl'
import { createPortal } from 'react-dom'

import { DeleteScorecardRowButton, DeleteScorecardsDialog } from '@/features/delete-scorecard'
import { isTraceEvaluation, TRACE_EVAL_REF, type ScorecardRecord } from '@/entities/scorecard'
import {
  dayKeyOf,
  fmtDateHeading,
  fmtDateTime,
  fmtDateTimeFull,
  fmtSubject,
  fmtTimeOnly,
} from '@/shared/lib/format'
import { usePersistentFilters } from '@/shared/lib/use-persistent-filters'
import { cn } from '@/shared/lib/utils'
import { UserAvatar } from '@/shared/ui/avatar'
import { Button } from '@/shared/ui/button'
import { EntityRef, MetricChip, ModelChip, SubsetChip } from '@/shared/ui/chip'
import { Combobox } from '@/shared/ui/combobox'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input } from '@/shared/ui/input'
import { OriginChip } from '@/shared/ui/origin'
import { ResetFiltersButton } from '@/shared/ui/reset-filters-button'
import { StatCard } from '@/shared/ui/stat-card'
import { StatusIcon } from '@/shared/ui/status-pill'

type Sort = 'recent' | 'name'
type Author = { name: string; avatarUrl?: string }

// Filter defaults that persist across page navigation (query, sort, dataset, harness, status, runner).
const FILTER_DEFAULTS = {
  query: '',
  sort: 'recent' as Sort,
  dataset: '',
  harness: '',
  status: '',
  user: '',
}

// Scorecard list — same pattern as the dataset list (search + Combobox filter + sort + runner avatar).
export function ScorecardList({
  workspace,
  scorecards,
  authors,
  viewer,
}: {
  workspace: string
  scorecards: ScorecardRecord[]
  authors: Record<string, Author>
  // Delete gating (mirrors the harness/judge list-row trash): a workspace admin deletes any terminal batch, a
  // member only their own. The control plane is the final enforcer — this only pre-hides the button.
  viewer: { subject?: string; admin: boolean }
}) {
  const t = useTranslations('scorecardList')
  const locale = useLocale()
  const timeZone = useTimeZone()
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
  // Filter/search state is remembered per workspace (persists across navigation) — show the reset button when dirty.
  const { values, set, reset, dirty } = usePersistentFilters(
    `scorecards:${workspace}`,
    FILTER_DEFAULTS
  )
  const { query, sort, dataset, harness, status, user } = values

  // Multi-select delete — a Set of selected scorecard ids (only ever deletable rows). While anything is selected the
  // list enters "selection mode": every checkbox stays visible and clicking a card toggles it instead of navigating,
  // so a stray click can't throw you into the detail page mid-selection. The selection also survives navigation via
  // sessionStorage (per tab + workspace). A floating action bar (portaled — see below) carries the bulk actions; the
  // row-level trash stays for the quick single-delete case.
  const selectionStorageKey = `everdict:selection:scorecards:${workspace}`
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const selectionMode = selected.size > 0
  // Persisted inside the state updater (usePersistentFilters grammar) — idempotent, so StrictMode double-invoke is fine.
  const persistSelection = (next: Set<string>) => {
    try {
      sessionStorage.setItem(selectionStorageKey, JSON.stringify([...next]))
    } catch {
      // sessionStorage blocked: the selection just won't survive navigation
    }
    return next
  }
  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return persistSelection(next)
    })
  const clearSelection = () => {
    setSelected(new Set())
    try {
      sessionStorage.removeItem(selectionStorageKey)
    } catch {
      // ignore
    }
  }
  const dropFromSelection = (ids: string[]) =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.delete(id)
      return persistSelection(next)
    })
  // Esc drops the whole selection (skipped while the confirm dialog is open — Esc there means "close the dialog").
  useEffect(() => {
    if (!selectionMode || confirming) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelected(new Set())
        try {
          sessionStorage.removeItem(selectionStorageKey)
        } catch {
          // ignore
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectionMode, confirming, selectionStorageKey])

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

  // Filter dropdown options — dataset · harness · runner (derived from all scorecards). The reserved trace-eval
  // sentinel is shown with a friendly label (so it reads as "Trace evaluation", not a literal "_traces" id).
  const datasetOptions = useMemo(() => {
    const s = new Set(scorecards.map((c) => c.dataset.id))
    return [
      { value: '', label: t('allDatasets') },
      ...[...s]
        .sort()
        .map((d) => ({ value: d, label: d === TRACE_EVAL_REF ? t('traceEvaluation') : d })),
    ]
  }, [scorecards, t])

  const harnessOptions = useMemo(() => {
    const s = new Set(scorecards.map((c) => c.harness.id))
    return [
      { value: '', label: t('allHarnesses') },
      ...[...s]
        .sort()
        .map((h) => ({ value: h, label: h === TRACE_EVAL_REF ? t('traceEvaluation') : h })),
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

  // Row-level delete gating — terminal batches only (a live one must be stopped first, same as the detail page).
  const canDeleteRow = (s: ScorecardRecord) =>
    s.status !== 'queued' &&
    s.status !== 'running' &&
    (viewer.admin || (s.createdBy !== undefined && s.createdBy === viewer.subject))
  // Keep the right-edge columns aligned: render the trash slot on every row iff any row is deletable.
  const showDeleteSlot = scorecards.some(canDeleteRow)

  // Restore the saved selection once after mount (SSR-safe: the first render is always empty), dropping ids that no
  // longer exist or stopped being deletable. Ref-guarded instead of a dep array so the lint deps stay honest.
  const hydratedRef = useRef(false)
  useEffect(() => {
    if (hydratedRef.current) return
    hydratedRef.current = true
    try {
      const raw = sessionStorage.getItem(selectionStorageKey)
      if (!raw) return
      const saved: unknown = JSON.parse(raw)
      if (!Array.isArray(saved)) return
      const deletable = new Set(scorecards.filter(canDeleteRow).map((s) => s.id))
      const valid = saved.filter((x): x is string => typeof x === 'string' && deletable.has(x))
      if (valid.length > 0) setSelected(persistSelection(new Set(valid)))
    } catch {
      // sessionStorage blocked / JSON corrupt: keep an empty selection
    }
  })

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

  // "Select all" adds every currently-visible deletable row to the selection (keeps ones hidden by a filter untouched).
  const selectAllVisible = () =>
    setSelected((prev) => {
      const next = new Set(prev)
      for (const s of visible) if (canDeleteRow(s)) next.add(s.id)
      return persistSelection(next)
    })
  // Shift-click selects the whole range between the last-toggled row (the anchor) and the clicked one. The anchor is
  // tracked by id so a filter/sort change can't mis-range; if it left the visible list, fall back to a plain toggle.
  const anchorRef = useRef<string | null>(null)
  const handleToggle = (id: string, shiftKey: boolean) => {
    const anchor = anchorRef.current
    if (shiftKey && anchor !== null && anchor !== id) {
      const from = visible.findIndex((s) => s.id === anchor)
      const to = visible.findIndex((s) => s.id === id)
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from < to ? [from, to] : [to, from]
        const range = visible
          .slice(lo, hi + 1)
          .filter(canDeleteRow)
          .map((s) => s.id)
        setSelected((prev) => persistSelection(new Set([...prev, ...range])))
        anchorRef.current = id
        return
      }
    }
    toggleSelect(id)
    anchorRef.current = id
  }
  // The confirm dialog needs each selected batch's coordinates — resolve ids against the full list (some may be filtered out).
  const byId = useMemo(() => new Map(scorecards.map((s) => [s.id, s])), [scorecards])
  const selectedTargets = [...selected]
    .map((id) => byId.get(id))
    .filter((s): s is ScorecardRecord => s !== undefined)

  // Keep the floating action bar centered over the eval (left) content region, not the full viewport. The bar is
  // portaled to <body> and `fixed`, so `inset-x-0` would center it across the whole screen — when the infra split
  // panel opens on the right the bar would slide under it. Measure this list's in-flow content box (which reflows
  // when the panel opens) and pin the bar to it; observing the enclosing <main> catches the panel toggle + resize
  // (its width always changes when the panel takes/releases its flex share), leaving mobile (fixed overlay panel,
  // full-width main) exactly as before.
  const rootRef = useRef<HTMLDivElement>(null)
  const [barBox, setBarBox] = useState<{ left: number; width: number } | null>(null)
  useEffect(() => {
    const el = rootRef.current
    if (!el || !selectionMode) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      setBarBox({ left: r.left, width: r.width })
    }
    measure()
    const observed = el.closest('main') ?? el
    const ro = new ResizeObserver(measure)
    ro.observe(observed)
    window.addEventListener('resize', measure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [selectionMode])

  return (
    <div ref={rootRef} className="space-y-5">
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
            onChange={(e) => set('query', e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="pl-8"
            aria-label={t('searchAria')}
          />
        </div>
        <Combobox
          options={datasetOptions}
          value={dataset}
          onChange={(v) => set('dataset', v)}
          placeholder={t('datasetPlaceholder')}
          className="w-[150px]"
        />
        <Combobox
          options={harnessOptions}
          value={harness}
          onChange={(v) => set('harness', v)}
          placeholder={t('harnessPlaceholder')}
          className="w-[150px]"
        />
        <Combobox
          options={statusOptions}
          value={status}
          onChange={(v) => set('status', v)}
          placeholder={t('statusPlaceholder')}
          className="w-[130px]"
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
        <div className="space-y-4">
          {(sort === 'recent'
            ? // recent sort: grouped by date (header = today/yesterday/date, rows show time only)
              [
                ...visible
                  .reduce((m, s) => {
                    const k = dayKeyOf(s.createdAt, timeZone)
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
                  {fmtDateHeading(items[0].createdAt, locale, timeZone)}
                </h4>
              )}
              {items.map((s, i) => {
                const author = authorInfo(s)
                const metrics = s.summary ?? []
                const shownMetrics = metrics.slice(0, 3) // keep the card format — top 3 only, the rest as +N
                const judges = s.judgeModels ?? []
                const selectable = canDeleteRow(s)
                const isSelected = selected.has(s.id)
                return (
                  // Fixed-format card — 3 lines (dataset/harness/aggregate), no arrow·inline name. Status is a color icon only.
                  <Link
                    key={s.id}
                    href={`/${workspace}/scorecards/${encodeURIComponent(s.id)}`}
                    style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}
                    onClick={(e) => {
                      // Selection mode: a card click toggles (no-op on a non-deletable row) instead of navigating —
                      // a stray click must not throw the user into the detail page mid-selection.
                      if (!selectionMode) return
                      e.preventDefault()
                      if (selectable) handleToggle(s.id, e.shiftKey)
                    }}
                    className={cn(
                      'rise group flex items-center gap-3 rounded-lg border px-3.5 py-2.5 shadow-raise transition-colors',
                      selectionMode && 'select-none', // shift-range clicks must not highlight card text
                      isSelected
                        ? 'border-primary/50 bg-primary/[0.05]'
                        : 'bg-card hover:border-border-strong hover:bg-elevated'
                    )}
                  >
                    {/* Left multi-select checkbox — the visual box stays small but the hit target is a generous 32px
                        square (negative margins overlap the card padding; z-[1] wins the overlap). Hover-revealed
                        until a selection starts, then every checkbox stays visible. */}
                    {showDeleteSlot && (
                      <span className="relative z-[1] flex w-5 shrink-0 justify-center">
                        {selectable && (
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={isSelected}
                            aria-label={t('selectAria')}
                            onClick={(e) => {
                              // The whole card is a Link — stop it so the checkbox click doesn't navigate.
                              e.preventDefault()
                              e.stopPropagation()
                              handleToggle(s.id, e.shiftKey)
                            }}
                            className={cn(
                              '-m-2 grid size-8 place-items-center rounded-md outline-none transition-opacity hover:bg-accent/60 focus-visible:opacity-100',
                              isSelected || selectionMode
                                ? 'opacity-100'
                                : 'opacity-0 group-hover:opacity-100'
                            )}
                          >
                            <span
                              className={cn(
                                'grid size-[18px] place-items-center rounded border transition-colors',
                                isSelected
                                  ? 'border-primary bg-primary text-primary-foreground'
                                  : 'border-border-strong bg-card'
                              )}
                            >
                              {isSelected && <Check className="size-3" strokeWidth={3} />}
                            </span>
                          </button>
                        )}
                      </span>
                    )}
                    {/* Left: 3 lines — ① dataset ② harness (+model·source) ③ aggregate chips. Each one line, truncated
                        (no wrap). A trace evaluation (sentinel dataset/harness) collapses ①② into a single badge line
                        instead of two literal "_traces" refs that would read as a broken entity. */}
                    <div className="min-w-0 flex-1 space-y-1">
                      {isTraceEvaluation(s) ? (
                        <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[13px] font-[510]">
                          <span className="inline-flex shrink-0 items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[11px] font-[560] text-secondary-foreground ring-1 ring-inset ring-border">
                            <Telescope className="size-3" />
                            {t('traceEvaluation')}
                          </span>
                          {s.models?.primary ? (
                            <span className="hidden shrink-0 sm:inline-flex">
                              <ModelChip>{s.models.primary}</ModelChip>
                            </span>
                          ) : null}
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[13px] font-[510]">
                            <span className="truncate">
                              <EntityRef
                                id={s.dataset.id}
                                version={s.dataset.version}
                                kind="dataset"
                              />
                            </span>
                            {s.subset ? (
                              <span className="shrink-0">
                                <SubsetChip selected={s.subset.selected} total={s.subset.total} />
                              </span>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[13px] font-[510]">
                            <span className="truncate">
                              <EntityRef
                                id={s.harness.id}
                                version={s.harness.version}
                                kind="harness"
                              />
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
                        </>
                      )}
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
                        title={fmtDateTimeFull(s.createdAt, { locale, timeZone })}
                      >
                        {sort === 'recent'
                          ? fmtTimeOnly(s.createdAt, timeZone)
                          : fmtDateTime(s.createdAt, timeZone)}
                      </time>
                      <span className="flex w-5 justify-end">
                        <StatusIcon status={s.status} />
                      </span>
                      {/* Hover-revealed trash (harness/judge list grammar) — a fixed slot keeps the columns aligned. */}
                      {showDeleteSlot && (
                        <span className="flex w-7 justify-end">
                          {canDeleteRow(s) && (
                            <DeleteScorecardRowButton
                              id={s.id}
                              dataset={s.dataset}
                              harness={s.harness}
                              workspace={workspace}
                            />
                          )}
                        </span>
                      )}
                    </div>
                  </Link>
                )
              })}
            </section>
          ))}
        </div>
      )}

      {/* Floating action bar — appears while any row is selected (Linear-style) and fans out the delete over the
          selection. Portaled to <body> (dialog.tsx grammar): the page-transition wrapper animates transform, and a
          transformed ancestor becomes the containing block for `fixed` — inline, the bar would pin to the bottom of
          the page content (below the fold on a long list) instead of the viewport. */}
      {selected.size > 0 &&
        createPortal(
          <div
            className="fixed bottom-6 z-30 flex justify-center px-4"
            style={barBox ? { left: barBox.left, width: barBox.width } : { left: 0, right: 0 }}
          >
            <div className="flex items-center gap-1 rounded-xl border border-border bg-card/95 px-2.5 py-2 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-card/80">
              <span className="px-1.5 text-[12.5px] font-[510] tabular-nums text-foreground">
                {t('selectedCount', { count: selected.size })}
              </span>
              <span className="mx-1 h-4 w-px bg-border" />
              <button
                type="button"
                onClick={selectAllVisible}
                className="rounded-md px-2 py-1 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {t('selectAllVisible')}
              </button>
              <button
                type="button"
                onClick={clearSelection}
                className="rounded-md px-2 py-1 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {t('clearSelection')}
              </button>
              <Button
                variant="destructive"
                size="sm"
                className="ml-1"
                onClick={() => setConfirming(true)}
              >
                <Trash2 className="size-3.5" />
                {t('deleteSelected')}
              </Button>
            </div>
          </div>,
          document.body
        )}
      {confirming && (
        <DeleteScorecardsDialog
          onClose={() => setConfirming(false)}
          targets={selectedTargets.map((s) => ({
            id: s.id,
            dataset: s.dataset,
            harness: s.harness,
          }))}
          onDeleted={dropFromSelection}
        />
      )}
    </div>
  )
}
