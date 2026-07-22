'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { CheckCircle2, CircleSlash, RefreshCw, Search, Telescope, XCircle } from 'lucide-react'
import { useLocale, useTimeZone, useTranslations } from 'next-intl'

import type { TraceSummary } from '@/entities/trace'
import type { TraceSourceConfig } from '@/entities/trace-source'
import {
  dayKeyOf,
  fmtDateHeading,
  fmtDateTimeFull,
  fmtDurationMs,
  fmtTimeOnly,
  fmtTokens,
  fmtUsd,
} from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { ModelChip } from '@/shared/ui/chip'
import { Combobox } from '@/shared/ui/combobox'
import { EmptyState } from '@/shared/ui/empty-state'
import { Input } from '@/shared/ui/input'
import { Tooltip } from '@/shared/ui/tooltip'

import { listTracesAction } from '../api/browse-traces'
import { TraceDetailDialog } from './trace-detail-dialog'

type StatusFilter = 'all' | 'ok' | 'error'
type TraceStatus = 'ok' | 'error' | 'unset'

const PAGE_SIZE = 50 // first load + each "load more" increment
const MAX_LIMIT = 500 // the control plane's listTraces limit cap

// Card display standard: status = color icon only, label in a hover tooltip (same principle as StatusIcon/UserAvatar).
const STATUS_ICON: Record<TraceStatus, { icon: typeof CheckCircle2; className: string }> = {
  ok: { icon: CheckCircle2, className: 'text-[var(--color-success)]' },
  error: { icon: XCircle, className: 'text-destructive' },
  unset: { icon: CircleSlash, className: 'text-faint' },
}

function TraceStatusIcon({ status }: { status: TraceStatus }) {
  const t = useTranslations('traceBrowser')
  const { icon: Icon, className } = STATUS_ICON[status]
  const label = t(`status_${status}`)
  return (
    <Tooltip content={label} align="end">
      <span aria-label={label} className={cn('inline-flex', className)}>
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
    </Tooltip>
  )
}

// The workspace observability trace browser — pick a registered source, list its recent traces + metrics, drill into one.
// Reused by the judge wizard (pass onPick to select a sample trace instead of expanding an inline detail).
export function TraceBrowser({
  sources,
  onPick,
  selectedTraceId,
}: {
  sources: TraceSourceConfig[]
  onPick?: (trace: TraceSummary, sourceName: string) => void
  selectedTraceId?: string
}) {
  const t = useTranslations('traceBrowser')
  const locale = useLocale()
  const timeZone = useTimeZone()
  const [sourceName, setSourceName] = useState(sources[0]?.name ?? '')
  const source = useMemo(() => sources.find((s) => s.name === sourceName), [sources, sourceName])
  const [scope, setScope] = useState('')
  const [filter, setFilter] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [traces, setTraces] = useState<TraceSummary[]>([])
  const [error, setError] = useState<string | undefined>()
  const [loaded, setLoaded] = useState(false)
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [openTrace, setOpenTrace] = useState<TraceSummary | undefined>()
  const [pending, start] = useTransition()
  const loadedSource = useRef<string | undefined>(undefined)

  const load = useCallback(
    (name: string, scopeValue: string, limitValue: number) => {
      if (!name) return
      start(async () => {
        setError(undefined)
        setOpenTrace(undefined)
        const res = await listTracesAction(name, {
          ...(scopeValue ? { scope: scopeValue } : {}),
          limit: limitValue,
        })
        if (res.ok) {
          setTraces(res.traces)
          setLoaded(true)
        } else {
          setError(res.error)
          setTraces([])
          setLoaded(true)
        }
      })
    },
    [start]
  )

  // Auto-load ONCE per selected source, keyed by NAME — never by the `source` object identity: each server-action
  // response re-renders the route and hands this island a fresh `sources` array, so an identity-keyed effect re-fires
  // after every listTracesAction call (an infinite refresh loop). Beyond this, refreshing is strictly user-driven
  // (reload button / Enter on scope / load more).
  useEffect(() => {
    if (!source || loadedSource.current === source.name) return
    loadedSource.current = source.name
    const defaultScope = source.project ?? source.service ?? ''
    setScope(defaultScope)
    setLimit(PAGE_SIZE)
    load(source.name, defaultScope, PAGE_SIZE)
  }, [source, load])

  // The page can mount with zero sources (initial state '') — adopt the first source registered while mounted so the
  // browser doesn't sit on an empty pick after "Add source".
  useEffect(() => {
    const first = sources[0]?.name
    if (!sourceName && first) setSourceName(first)
  }, [sources, sourceName])

  const loadMore = () => {
    const next = Math.min(limit + PAGE_SIZE, MAX_LIMIT)
    setLimit(next)
    load(sourceName, scope, next)
  }

  // Filter → recent-first order → date groups (header = today/yesterday/date, rows show time only; undated rows
  // form a trailing headerless group). `flat` is the on-screen order the detail dialog's prev/next walks.
  const { groups, flat } = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const matched = traces.filter((tr) => {
      if (status !== 'all' && (tr.status ?? 'unset') !== status) return false
      if (!q) return true
      return (
        tr.id.toLowerCase().includes(q) ||
        (tr.name?.toLowerCase().includes(q) ?? false) ||
        (tr.llmModel?.toLowerCase().includes(q) ?? false)
      )
    })
    const sorted = [...matched].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
    const byDay = new Map<string, TraceSummary[]>()
    for (const tr of sorted) {
      const key = tr.startedAt ? dayKeyOf(tr.startedAt, timeZone) : ''
      const group = byDay.get(key)
      if (group) group.push(tr)
      else byDay.set(key, [tr])
    }
    return { groups: [...byDay.entries()], flat: sorted }
  }, [traces, filter, status, timeZone])

  if (sources.length === 0) {
    return (
      <EmptyState
        icon={<Telescope className="size-5" />}
        title={t('noSourcesTitle')}
        hint={t('noSourcesHint')}
      />
    )
  }

  // Row click always drills into the detail dialog — in pick mode (onPick set) the dialog carries a
  // "Use this trace" action, so choosing = inspect first, then confirm (with prev/next to compare siblings).
  const rowClick = (tr: TraceSummary) => setOpenTrace(tr)
  const openIndex = openTrace ? flat.findIndex((tr) => tr.id === openTrace.id) : -1

  const statusOptions: { value: StatusFilter; label: string }[] = [
    { value: 'all', label: t('status_all') },
    { value: 'ok', label: t('status_ok') },
    { value: 'error', label: t('status_error') },
  ]

  return (
    <div className="space-y-4">
      {/* Filter bar — search + source/scope pick + status + reload (the shared list-page bar format). */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('filterPlaceholder')}
            className="pl-8"
            aria-label={t('filterPlaceholder')}
          />
        </div>
        <Combobox
          options={sources.map((s) => ({ value: s.name, label: s.name, hint: s.kind }))}
          value={sourceName}
          onChange={setSourceName}
          className="w-[180px]"
          aria-label={t('sourceLabel')}
        />
        <Input
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load(sourceName, scope, limit)}
          placeholder={t('scopePlaceholder')}
          className="w-[180px]"
          aria-label={t('scopeLabel')}
        />
        <Combobox
          options={statusOptions.map((s) => ({ value: s.value, label: s.label }))}
          value={status}
          onChange={(v) => setStatus(v as StatusFilter)}
          className="w-[110px]"
          align="end"
          aria-label={t('colStatus')}
        />
        <Button
          variant="secondary"
          size="md"
          onClick={() => load(sourceName, scope, limit)}
          disabled={pending}
        >
          <RefreshCw className={cn('size-4', pending && 'animate-spin')} />
          {t('reload')}
        </Button>
      </div>

      {error && <Callout tone="danger">{error}</Callout>}

      {loaded && !error && traces.length === 0 && (
        <EmptyState
          icon={<Telescope className="size-5" />}
          title={t('noTracesTitle')}
          hint={
            source && (source.kind === 'mlflow' || source.kind === 'otel')
              ? t('noTracesScopeHint')
              : t('noTracesHint')
          }
        />
      )}

      {flat.length > 0 && (
        <div className="space-y-4">
          {loaded && !error && (
            <p className="px-0.5 text-right text-[12px] text-faint">
              {t('traceCount', { shown: flat.length, total: traces.length })}
            </p>
          )}
          {groups.map(([day, items]) => (
            <section key={day || 'undated'} className="space-y-2">
              {day && items[0]?.startedAt && (
                <h4 className="px-0.5 text-[11.5px] font-[560] uppercase tracking-wide text-faint">
                  {fmtDateHeading(items[0].startedAt, locale, timeZone)}
                </h4>
              )}
              {items.map((tr, i) => {
                const isPicked = selectedTraceId === tr.id || openTrace?.id === tr.id
                return (
                  // Fixed-format card row — left ① name+model ② mono id·span count, right metric slots + status icon.
                  <button
                    key={tr.id}
                    type="button"
                    onClick={() => rowClick(tr)}
                    style={{ animationDelay: `${Math.min(i, 12) * 28}ms` }}
                    className={cn(
                      'rise flex w-full items-center gap-3 rounded-lg border bg-card px-3.5 py-2.5 text-left shadow-raise transition-colors hover:border-border-strong hover:bg-elevated',
                      isPicked && 'border-border-strong bg-elevated'
                    )}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[13px] font-[510]">
                        <span className="truncate">{tr.name ?? t('unnamedTrace')}</span>
                        {tr.llmModel && (
                          <span className="hidden shrink-0 sm:inline-flex">
                            <ModelChip muted>{tr.llmModel}</ModelChip>
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap font-mono text-[10.5px] text-faint">
                        <span className="truncate">{tr.id}</span>
                        {tr.spanCount !== undefined && (
                          <span className="shrink-0">
                            · {t('spanCount', { count: tr.spanCount })}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2.5">
                      <span
                        title={t('colTokens')}
                        className="hidden w-[88px] text-right font-mono text-[11px] tabular-nums text-muted-foreground lg:block"
                      >
                        {tr.tokens
                          ? `${fmtTokens(tr.tokens.input)}→${fmtTokens(tr.tokens.output)}`
                          : '–'}
                      </span>
                      <span
                        title={t('colCost')}
                        className="hidden w-[64px] text-right font-mono text-[11px] tabular-nums text-muted-foreground md:block"
                      >
                        {fmtUsd(tr.costUsd)}
                      </span>
                      <span
                        title={t('colDuration')}
                        className="hidden w-[56px] text-right font-mono text-[11px] tabular-nums text-muted-foreground sm:block"
                      >
                        {fmtDurationMs(tr.durationMs)}
                      </span>
                      <time
                        className="hidden w-[44px] text-right font-mono text-[11px] text-muted-foreground sm:block"
                        title={
                          tr.startedAt
                            ? fmtDateTimeFull(tr.startedAt, { locale, timeZone })
                            : undefined
                        }
                      >
                        {tr.startedAt ? fmtTimeOnly(tr.startedAt, timeZone) : '–'}
                      </time>
                      <span className="flex w-5 justify-end">
                        <TraceStatusIcon status={tr.status ?? 'unset'} />
                      </span>
                    </div>
                  </button>
                )
              })}
            </section>
          ))}
        </div>
      )}

      {/* A full page means the platform may hold more — grow the limit and refetch (user-driven, no cursor state). */}
      {!error && traces.length >= limit && limit < MAX_LIMIT && (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" disabled={pending} onClick={loadMore}>
            {t('loadMore')}
          </Button>
        </div>
      )}

      {/* The observability-grade detail dialog — prev/next walks the filtered on-screen order; pick mode adds "Use this trace". */}
      {openTrace && (
        <TraceDetailDialog
          open
          onClose={() => setOpenTrace(undefined)}
          sourceName={sourceName}
          trace={openTrace}
          nav={
            openIndex >= 0
              ? {
                  index: openIndex,
                  total: flat.length,
                  onPrev: () => setOpenTrace(flat[openIndex - 1] ?? openTrace),
                  onNext: () => setOpenTrace(flat[openIndex + 1] ?? openTrace),
                }
              : undefined
          }
          onSelect={
            onPick
              ? (tr) => {
                  onPick(tr, sourceName)
                  setOpenTrace(undefined)
                }
              : undefined
          }
        />
      )}
    </div>
  )
}
