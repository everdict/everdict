'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { RefreshCw, Search, Telescope } from 'lucide-react'
import { useTranslations } from 'next-intl'

import type { TraceSummary } from '@/entities/trace'
import type { TraceSourceConfig } from '@/entities/trace-source'
import { fmtDateTime, fmtDateTimeFull, fmtDurationMs, fmtTokens, fmtUsd } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Callout } from '@/shared/ui/callout'
import { ModelChip } from '@/shared/ui/chip'
import { Combobox } from '@/shared/ui/combobox'
import { EmptyState } from '@/shared/ui/empty-state'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

import { listTracesAction } from '../api/browse-traces'
import { TraceDetailDialog } from './trace-detail-dialog'

type StatusFilter = 'all' | 'ok' | 'error'

const PAGE_SIZE = 50 // first load + each "load more" increment
const MAX_LIMIT = 500 // the control plane's listTraces limit cap

const STATUS_TONE: Record<'ok' | 'error' | 'unset', 'success' | 'danger' | 'outline'> = {
  ok: 'success',
  error: 'danger',
  unset: 'outline',
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

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return traces.filter((tr) => {
      if (status !== 'all' && (tr.status ?? 'unset') !== status) return false
      if (!q) return true
      return (
        tr.id.toLowerCase().includes(q) ||
        (tr.name?.toLowerCase().includes(q) ?? false) ||
        (tr.llmModel?.toLowerCase().includes(q) ?? false)
      )
    })
  }, [traces, filter, status])

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
  const openIndex = openTrace ? shown.findIndex((tr) => tr.id === openTrace.id) : -1

  return (
    <div className="space-y-3">
      {/* Toolbar: source + scope + reload */}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-[510] text-faint">{t('sourceLabel')}</span>
          <Combobox
            options={sources.map((s) => ({ value: s.name, label: s.name, hint: s.kind }))}
            value={sourceName}
            onChange={setSourceName}
            className="w-56"
            aria-label={t('sourceLabel')}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-[510] text-faint">{t('scopeLabel')}</span>
          <input
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load(sourceName, scope, limit)}
            placeholder={t('scopePlaceholder')}
            className="h-8 w-56 rounded-md border border-border bg-background px-2.5 text-[13px] outline-none focus:border-border-strong"
          />
        </label>
        <Button
          variant="secondary"
          size="md"
          onClick={() => load(sourceName, scope, limit)}
          disabled={pending}
        >
          <RefreshCw className={cn('size-4', pending && 'animate-spin')} />
          {t('reload')}
        </Button>
        {loaded && !error && (
          <span className="ml-auto pb-1.5 text-[12px] text-faint">
            {t('traceCount', { shown: shown.length, total: traces.length })}
          </span>
        )}
      </div>

      {/* Filters */}
      {traces.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('filterPlaceholder')}
              className="h-7 w-52 rounded-md border border-border bg-background pl-7 pr-2 text-[12px] outline-none focus:border-border-strong"
            />
          </div>
          <div className="flex gap-1">
            {(['all', 'ok', 'error'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                className={cn(
                  'rounded-md border px-2 py-1 text-[11px] transition-colors',
                  status === s
                    ? 'border-border-strong bg-secondary text-foreground'
                    : 'border-border text-faint hover:text-foreground'
                )}
              >
                {t(`status_${s}`)}
              </button>
            ))}
          </div>
        </div>
      )}

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

      {shown.length > 0 && (
        <Table>
          <THead>
            <TR>
              <TH className="w-[34%]">{t('colTrace')}</TH>
              <TH>{t('colModel')}</TH>
              <TH>{t('colStarted')}</TH>
              <TH className="text-right">{t('colDuration')}</TH>
              <TH className="text-right">{t('colTokens')}</TH>
              <TH className="text-right">{t('colCost')}</TH>
              <TH>{t('colStatus')}</TH>
            </TR>
          </THead>
          <TBody>
            {shown.map((tr) => {
              const isPicked = selectedTraceId === tr.id || openTrace?.id === tr.id
              return (
                <Fragment key={tr.id}>
                  <TR
                    onClick={() => rowClick(tr)}
                    className={cn('cursor-pointer', isPicked && 'bg-elevated/70')}
                  >
                    <TD>
                      <div className="truncate font-[510] text-foreground">
                        {tr.name ?? t('unnamedTrace')}
                      </div>
                      <div className="truncate font-mono text-[10px] text-faint">{tr.id}</div>
                    </TD>
                    <TD>
                      {tr.llmModel ? (
                        <ModelChip muted>{tr.llmModel}</ModelChip>
                      ) : (
                        <span className="text-faint">–</span>
                      )}
                    </TD>
                    <TD>
                      {tr.startedAt ? (
                        <span
                          title={fmtDateTimeFull(tr.startedAt)}
                          className="tabular-nums text-muted-foreground"
                        >
                          {fmtDateTime(tr.startedAt)}
                        </span>
                      ) : (
                        <span className="text-faint">–</span>
                      )}
                    </TD>
                    <TD className="text-right tabular-nums text-muted-foreground">
                      {fmtDurationMs(tr.durationMs)}
                    </TD>
                    <TD className="text-right tabular-nums text-muted-foreground">
                      {tr.tokens
                        ? `${fmtTokens(tr.tokens.input)}→${fmtTokens(tr.tokens.output)}`
                        : '–'}
                    </TD>
                    <TD className="text-right tabular-nums text-muted-foreground">
                      {fmtUsd(tr.costUsd)}
                    </TD>
                    <TD>
                      <Badge tone={STATUS_TONE[tr.status ?? 'unset']}>
                        {t(`status_${tr.status ?? 'unset'}`)}
                      </Badge>
                    </TD>
                  </TR>
                </Fragment>
              )
            })}
          </TBody>
        </Table>
      )}

      {/* A full page means the platform may hold more — grow the limit and refetch (user-driven, no cursor state). */}
      {!error && traces.length >= limit && limit < MAX_LIMIT && (
        <div className="flex justify-center">
          <Button variant="ghost" size="sm" disabled={pending} onClick={loadMore}>
            {t('loadMore')}
          </Button>
        </div>
      )}

      {/* The observability-grade detail dialog — prev/next walks the filtered list; pick mode adds "Use this trace". */}
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
                  total: shown.length,
                  onPrev: () => setOpenTrace(shown[openIndex - 1] ?? openTrace),
                  onNext: () => setOpenTrace(shown[openIndex + 1] ?? openTrace),
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
