'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'

import type { TraceEvent } from '@/entities/trace'
import { fmtDurationMs, fmtTokens, fmtUsd } from '@/shared/lib/format'
import { cn } from '@/shared/lib/utils'

import type { TrajectorySegment } from '../api/browse-trajectories'
import { placeTrajectory, type Lane, type PlacedEvent } from '../lib/trajectory-planes'
import { AttributesView, IoPanel } from './data-view'

// The owned trajectory's SYSTEM view — every plane the sealed evidence carries, read as one run: the
// agent's own steps, the orchestrator's account of where it ran, and one lane per service that pushed its
// own OTel spans into this run. The platform TraceDetailDialog's grammar — timeline on top, list left,
// selected item's full payload right — over OUR vocabulary: a normalized TraceEvent stream per emitter,
// not one span tree.
//
// The one rule this view inherits verbatim from data-view: payloads render IN FULL. A trajectory is
// evidence, and evidence elided at 200 characters is not evidence.
//
// This is the product's ONE trace-reading surface: the settings trajectory dialog and the run detail's
// evidence section render the same component (the run page's bespoke vertical timeline is gone). It is
// its own `@container`, so the split point is ITS width, not the viewport's — the same view opens
// 2-pane in the near-fullscreen dialog and stacks inside a run detail narrowed by the infra panel.

// Kind accent — the same hues the platform waterfall uses for span types, so the two surfaces read alike.
const KIND_COLOR: Record<TraceEvent['kind'], string> = {
  message: '#8a8f98',
  llm_call: '#9d7be6',
  tool_call: '#3fb6b2',
  tool_result: '#3fb6b2',
  env_action: '#5e6ad2',
  error: '#eb5757',
  log: '#8a8f98',
  artifact: '#4cb782',
  span: '#8a8f98',
  infra: '#e0a04c',
}

// Every event field that carries a PAYLOAD (a value worth reading whole) → its own copyable panel.
// Everything else becomes an attribute row. Split per kind so neither side has to guess.
function payloadsOf(event: TraceEvent): { label: string; text: string }[] {
  switch (event.kind) {
    case 'message':
      return [{ label: 'text', text: event.text }]
    case 'tool_call':
      return event.args === undefined
        ? []
        : [
            {
              label: 'args',
              text: typeof event.args === 'string' ? event.args : safeJson(event.args),
            },
          ]
    case 'tool_result':
      return event.output === '' ? [] : [{ label: 'output', text: event.output }]
    case 'error':
      return [{ label: 'message', text: event.message }]
    case 'log':
      return [{ label: 'text', text: event.text }]
    case 'env_action':
      return event.detail === undefined ? [] : [{ label: 'detail', text: safeJson(event.detail) }]
    case 'infra':
      return [{ label: 'message', text: event.message }]
    default:
      return []
  }
}

// The scalar fields of an event — the attribute table's rows. `span.attributes` merges in verbatim
// (it IS an attribute bag), so an ingested structural span finally shows what it was carrying.
function attributesOf(event: TraceEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(event as Record<string, unknown>)) {
    if (value === undefined) continue
    // `kind` and `t` head the identity strip above — an attribute row would just repeat them.
    if (key === 'kind' || key === 't') continue
    if (key === 'attributes' && typeof value === 'object' && value !== null) {
      for (const [ak, av] of Object.entries(value as Record<string, unknown>)) out[ak] = av
      continue
    }
    // Payload fields have their own panel above — never duplicated as a truncated attribute row.
    if (['text', 'args', 'output', 'message', 'detail'].includes(key)) continue
    out[key] = value
  }
  return out
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

// One-line summary for the list row — the full value is always one click away in the side panel.
function summarize(event: TraceEvent): string {
  switch (event.kind) {
    case 'message':
      return `${event.role}: ${event.text}`
    case 'llm_call':
      return event.model
    case 'tool_call':
      return `→ ${event.name}`
    case 'tool_result':
      return `← ${event.output}`
    case 'env_action':
      return event.action
    case 'error':
      return event.message
    case 'log':
      return event.text
    case 'artifact':
      return `${event.name} · ${event.ref}`
    case 'span':
      return event.name
    case 'infra':
      return `${event.event ? `${event.event}: ` : ''}${event.message}`
  }
}

interface Rollup {
  llmCalls: number
  toolCalls: number
  toolFailures: number
  errors: number
  inputTokens: number
  outputTokens: number
  usd: number
}

// The trajectory's own arithmetic — the control plane's trajectoryMetrics, recomputed here because the web
// may not import @everdict/domain. Counted across EVERY plane: this view answers "what did the system do",
// so a service's own LLM call is part of the run's cost, not someone else's.
function rollupOf(placed: PlacedEvent[]): Rollup {
  const out: Rollup = {
    llmCalls: 0,
    toolCalls: 0,
    toolFailures: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    usd: 0,
  }
  for (const { event } of placed) {
    if (event.kind === 'llm_call') {
      out.llmCalls += 1
      if (event.cost) {
        out.inputTokens += event.cost.inputTokens
        out.outputTokens += event.cost.outputTokens
        out.usd += event.cost.usd
      }
    } else if (event.kind === 'tool_call') out.toolCalls += 1
    else if (event.kind === 'tool_result') {
      if (!event.ok) out.toolFailures += 1
    } else if (event.kind === 'error') out.errors += 1
  }
  return out
}

// The run detail renders the same view over a single sealed stream — one segment, no service planes.
export function asSingleSegment(
  events: TraceEvent[],
  source: TrajectorySegment['source']
): TrajectorySegment[] {
  return [{ emitter: source, source, eventCount: events.length, sealedAt: '', events }]
}

export function TrajectoryView({ segments }: { segments: TrajectorySegment[] }) {
  const t = useTranslations('trajectoryBrowser')
  const [lane, setLane] = useState<string>('all')
  const [selectedKey, setSelectedKey] = useState<string | undefined>()

  const { lanes, placed, axis, unanchored } = useMemo(() => placeTrajectory(segments), [segments])
  const rollup = useMemo(() => rollupOf(placed), [placed])
  // Anchored events read in the order they HAPPENED, across planes — that is the whole point of a system
  // view. Unanchored ones keep their segment order at the end rather than being sorted against a guess.
  const ordered = useMemo(() => {
    const anchored = placed.filter((p) => p.startMs !== undefined)
    const rest = placed.filter((p) => p.startMs === undefined)
    anchored.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0))
    return [...anchored, ...rest]
  }, [placed])
  const rows = useMemo(
    () => (lane === 'all' ? ordered : ordered.filter((p) => p.laneId === lane)),
    [ordered, lane]
  )

  const current = placed.find((p) => p.key === selectedKey) ?? ordered[0]

  if (placed.length === 0)
    return <p className="px-1 py-2 text-[12px] text-faint">{t('noEvents')}</p>

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      {/* Rollup — the numbers a reader would otherwise count by hand. Empty tiles stay hidden. */}
      <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-border px-1 pb-3">
        {axis && (
          <Metric label={t('rollupDuration')} value={fmtDurationMs(axis.endMs - axis.startMs)} />
        )}
        <Metric label={t('rollupEvents')} value={String(placed.length)} />
        {lanes.length > 1 && <Metric label={t('rollupPlanes')} value={String(lanes.length)} />}
        {rollup.llmCalls > 0 && (
          <Metric label={t('rollupLlmCalls')} value={String(rollup.llmCalls)} />
        )}
        {(rollup.inputTokens > 0 || rollup.outputTokens > 0) && (
          <Metric
            label={t('rollupTokens')}
            value={`${fmtTokens(rollup.inputTokens)}→${fmtTokens(rollup.outputTokens)}`}
          />
        )}
        {rollup.usd > 0 && <Metric label={t('rollupCost')} value={fmtUsd(rollup.usd)} />}
        {rollup.toolCalls > 0 && (
          <Metric label={t('rollupToolCalls')} value={String(rollup.toolCalls)} />
        )}
        {rollup.toolFailures > 0 && (
          <Metric label={t('rollupToolFailures')} value={String(rollup.toolFailures)} danger />
        )}
        {rollup.errors > 0 && (
          <Metric label={t('rollupErrors')} value={String(rollup.errors)} danger />
        )}
      </div>

      {/* The shared time axis — one lane per plane. Only drawn when the planes could actually be anchored
          against each other; a trajectory with no absolute stamps stays a list rather than a fiction. */}
      {axis && axis.endMs > axis.startMs && (
        <div className="mt-3 space-y-1">
          <div className="flex items-baseline justify-between">
            <span className="text-[11px] font-[510] uppercase tracking-wide text-faint">
              {t('timelineTitle')}
            </span>
            <span className="font-mono text-[10px] tabular-nums text-faint">
              {fmtDurationMs(axis.endMs - axis.startMs)}
            </span>
          </div>
          {lanes.map((laneRow) => (
            <LaneRow
              key={laneRow.id}
              lane={laneRow}
              label={laneLabel(laneRow, t)}
              axis={axis}
              events={placed.filter((p) => p.laneId === laneRow.id && p.startMs !== undefined)}
              selectedKey={current?.key}
              onSelect={setSelectedKey}
            />
          ))}
          {unanchored > 0 && (
            <p className="pt-1 text-[10.5px] text-faint">
              {t('unanchored', { count: unanchored })}
            </p>
          )}
        </div>
      )}

      {/* Lane axis — one chip per plane that HAS events; a single-plane trajectory shows no chips at all. */}
      {lanes.length > 1 && (
        <div className="mt-3 flex flex-wrap items-center gap-0.5 self-start rounded-md border border-border p-0.5">
          {[
            { id: 'all', label: t('plane_all'), count: placed.length },
            ...lanes.map((l) => ({ id: l.id, label: laneLabel(l, t), count: l.count })),
          ].map((chip) => (
            <button
              key={chip.id}
              type="button"
              onClick={() => setLane(chip.id)}
              className={cn(
                'rounded px-2 py-0.5 text-[11px] transition-colors',
                chip.id === lane
                  ? 'bg-muted text-foreground'
                  : 'text-faint hover:text-muted-foreground'
              )}
            >
              {chip.label}
              {chip.id !== 'all' && (
                <span className="ml-1 font-mono text-[10px] text-faint">{chip.count}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* List left, the selected event's full payload right — each pane scrolls on its own once the
          CONTAINER (not the viewport) is wide enough to hold both. */}
      <div className="mt-3 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto @3xl:flex-row @3xl:overflow-hidden">
        <ul className="min-w-0 flex-1 divide-y divide-border/50 overflow-hidden rounded-md border border-border bg-card/50 @3xl:overflow-y-auto">
          {rows.map((row) => (
            <li key={row.key}>
              <button
                type="button"
                onClick={() => setSelectedKey(row.key)}
                className={cn(
                  'flex w-full gap-3 px-3 py-1.5 text-left hover:bg-elevated/50',
                  row.key === current?.key && 'bg-primary/10'
                )}
              >
                <span className="w-8 shrink-0 pt-0.5 text-right font-mono text-[10px] tabular-nums text-faint">
                  {row.index}
                </span>
                <span
                  className="w-20 shrink-0 pt-0.5 font-mono text-[10px] uppercase tracking-wide"
                  style={{ color: KIND_COLOR[row.event.kind] }}
                >
                  {row.event.kind}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/90">
                  {summarize(row.event)}
                </span>
                {lanes.length > 1 && (
                  <span className="hidden shrink-0 self-center rounded-[3px] bg-elevated px-1 text-[9.5px] text-faint @lg:inline">
                    {laneLabel(laneOfId(lanes, row.laneId), t)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>

        <aside className="shrink-0 @3xl:w-[44%] @3xl:min-w-[360px] @3xl:max-w-[600px] @3xl:overflow-y-auto">
          {current ? (
            <EventDetail
              placed={current}
              laneLabel={laneLabel(laneOfId(lanes, current.laneId), t)}
            />
          ) : null}
        </aside>
      </div>
    </div>
  )
}

// One plane's band on the shared axis. A duration draws as a bar, an instant as a tick — both clickable,
// because a placement event with no duration is exactly the thing a reader wants to open.
function LaneRow({
  lane,
  label,
  axis,
  events,
  selectedKey,
  onSelect,
}: {
  lane: Lane
  label: string
  axis: { startMs: number; endMs: number }
  events: PlacedEvent[]
  selectedKey?: string
  onSelect: (key: string) => void
}) {
  const span = Math.max(1, axis.endMs - axis.startMs)
  return (
    <div className="grid items-center gap-2 [grid-template-columns:minmax(64px,120px)_1fr]">
      <span className="truncate text-[11px] text-muted-foreground" title={label}>
        {label}
      </span>
      <div className="relative h-5 rounded-[3px] bg-elevated/40">
        {events.map((placed) => {
          const left = (((placed.startMs ?? axis.startMs) - axis.startMs) / span) * 100
          const width = (placed.durationMs / span) * 100
          return (
            <button
              key={placed.key}
              type="button"
              onClick={() => onSelect(placed.key)}
              title={`${placed.event.kind} · ${summarize(placed.event).slice(0, 120)}`}
              aria-label={`${lane.label} ${placed.event.kind}`}
              className={cn(
                'absolute top-1/2 h-3 -translate-y-1/2 rounded-[2px] transition-opacity hover:opacity-100',
                placed.key === selectedKey ? 'opacity-100 ring-1 ring-primary' : 'opacity-75'
              )}
              style={{
                left: `${Math.min(left, 99.4)}%`,
                width: `${Math.max(width, 0.6)}%`,
                minWidth: 3,
                backgroundColor: KIND_COLOR[placed.event.kind],
              }}
            />
          )
        })}
      </div>
    </div>
  )
}

// One event, whole: its identity strip, every payload field in full, then everything else as attributes.
function EventDetail({ placed, laneLabel }: { placed: PlacedEvent; laneLabel: string }) {
  const t = useTranslations('trajectoryBrowser')
  const { event } = placed
  const payloads = payloadsOf(event)
  const attributes = attributesOf(event)

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="rounded-[3px] px-1 text-[9px] font-[700] uppercase tracking-wide"
          style={{ backgroundColor: `${KIND_COLOR[event.kind]}28`, color: KIND_COLOR[event.kind] }}
        >
          {event.kind}
        </span>
        <span className="text-[11px] text-faint">{laneLabel}</span>
        <span className="font-mono text-[11px] tabular-nums text-faint">
          #{placed.index} · t={event.t}
          {placed.durationMs > 0 ? ` · ${fmtDurationMs(placed.durationMs)}` : ''}
        </span>
        {event.kind === 'llm_call' && (
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {[
              event.model,
              event.cost
                ? `${fmtTokens(event.cost.inputTokens)}→${fmtTokens(event.cost.outputTokens)} · ${fmtUsd(event.cost.usd)}`
                : undefined,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
      </div>
      {payloads.map((payload) => (
        <IoPanel
          key={`${placed.key}-${payload.label}`}
          label={payload.label}
          text={payload.text}
          accent={payload.label === 'output'}
        />
      ))}
      <AttributesView attributes={attributes} />
      {payloads.length === 0 && Object.keys(attributes).length === 0 && (
        <p className="text-[12px] text-faint">{t('noPayload')}</p>
      )}
    </div>
  )
}

// The agent and placement lanes are product vocabulary (translated); a service lane is the service's own
// name, which is data and stays verbatim.
function laneLabel(lane: Lane | undefined, t: (key: string) => string): string {
  if (!lane) return ''
  if (lane.kind === 'agent') return t('plane_agent')
  if (lane.kind === 'placement') return t('plane_placement')
  return lane.label === '' ? t('plane_service') : lane.label
}

function laneOfId(lanes: Lane[], id: string): Lane | undefined {
  return lanes.find((lane) => lane.id === id)
}

function Metric({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-faint">{label}</span>
      <span className={cn('text-[13px] font-[560] tabular-nums', danger && 'text-destructive')}>
        {value}
      </span>
    </div>
  )
}
