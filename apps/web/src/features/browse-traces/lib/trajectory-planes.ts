import type { TraceEvent } from '@/entities/trace'

import type { TrajectorySegment } from '../api/browse-trajectories'

// Reading a sealed trajectory as a SYSTEM, not one process.
//
// Two axes, deliberately distinct:
// - a SEGMENT is who sealed the evidence (the execution's own record, or `service:<service.name>` for a
//   service under test that pushed its own OTel spans through the door);
// - a PLANE/LANE is what a reader wants to see side by side — the agent's own steps, the orchestrator's
//   account of where it ran (`infra` scope placement), and one lane per service.
// The execution segment alone already carries two of those planes, which is why the lane is derived from
// the EVENT, not only from the segment.

export type LaneKind = 'agent' | 'placement' | 'service'

export interface Lane {
  id: string
  kind: LaneKind
  label: string
  count: number
}

export interface PlacedEvent {
  key: string
  event: TraceEvent
  laneId: string
  emitter: string
  // Position within its own segment — the number a reader can point at ("event #12 of the checkout plane").
  index: number
  // Absolute wall-clock, present only when the segment could be anchored. Without it an event still shows
  // in the list; it just cannot be laid on the shared axis.
  startMs?: number
  durationMs: number
}

export const AGENT_LANE = 'agent'
export const PLACEMENT_LANE = 'placement'
const SERVICE_PREFIX = 'service:'

export function laneKindOf(laneId: string): LaneKind {
  if (laneId === AGENT_LANE) return 'agent'
  if (laneId === PLACEMENT_LANE) return 'placement'
  return 'service'
}

export function laneLabelOf(laneId: string): string {
  return laneId.startsWith(SERVICE_PREFIX) ? laneId.slice(SERVICE_PREFIX.length) : laneId
}

// Which lane one event belongs to. A service segment puts everything in its own lane; inside the
// execution's own record the `infra` scope splits placement from the topology units it drove.
function laneOf(segment: TrajectorySegment, event: TraceEvent): string {
  if (segment.emitter.startsWith(SERVICE_PREFIX)) return segment.emitter
  if (event.kind !== 'infra') return AGENT_LANE
  if (event.scope !== 'service') return PLACEMENT_LANE
  return event.service !== undefined ? `${SERVICE_PREFIX}${event.service}` : `${SERVICE_PREFIX}`
}

// The absolute instant a segment's relative `t` counts from. The store's own `t0` is authoritative; an
// older segment without one can still be anchored by any event carrying an absolute `at` (the infra plane
// stamps them exactly for this). Neither → unanchored, and we say so rather than guessing an offset.
export function anchorOf(segment: TrajectorySegment): number | undefined {
  if (segment.t0 !== undefined) {
    const parsed = Date.parse(segment.t0)
    if (Number.isFinite(parsed)) return parsed
  }
  for (const event of segment.events) {
    if (event.kind !== 'infra' || event.at === undefined) continue
    const parsed = Date.parse(event.at)
    if (Number.isFinite(parsed)) return parsed - event.t
  }
  return undefined
}

// How long an event occupied its lane. An instant (0) is drawn as a tick, not a zero-width bar.
// A tool call's length is its own result's arrival — the pair shares an id inside one segment.
function durationOf(event: TraceEvent, resultAt: Map<string, number>): number {
  if (event.kind === 'llm_call') return event.latencyMs ?? 0
  if (event.kind === 'span') return event.durationMs ?? 0
  if (event.kind === 'tool_call') {
    const end = resultAt.get(event.id)
    return end !== undefined && end > event.t ? end - event.t : 0
  }
  return 0
}

export interface PlacedTrajectory {
  lanes: Lane[]
  placed: PlacedEvent[]
  // The window every anchored event falls in — the shared axis. Absent when nothing could be anchored.
  // Named `axis`, not `window`: a component destructuring this must not shadow the global.
  axis?: { startMs: number; endMs: number }
  // Events that carry no absolute position. Reported, never silently dropped from the picture.
  unanchored: number
}

export function placeTrajectory(segments: TrajectorySegment[]): PlacedTrajectory {
  const placed: PlacedEvent[] = []
  const counts = new Map<string, number>()
  let unanchored = 0
  let startMs: number | undefined
  let endMs: number | undefined

  for (const segment of segments) {
    const anchor = anchorOf(segment)
    const resultAt = new Map<string, number>()
    for (const event of segment.events)
      if (event.kind === 'tool_result') resultAt.set(event.id, event.t)

    segment.events.forEach((event, index) => {
      const laneId = laneOf(segment, event)
      counts.set(laneId, (counts.get(laneId) ?? 0) + 1)
      const durationMs = durationOf(event, resultAt)
      // An infra event's own `at` beats the segment anchor: it is the emitter's absolute stamp, while the
      // anchor is an offset applied to a relative clock.
      const absolute =
        event.kind === 'infra' && event.at !== undefined && Number.isFinite(Date.parse(event.at))
          ? Date.parse(event.at)
          : anchor !== undefined
            ? anchor + event.t
            : undefined
      if (absolute === undefined) unanchored += 1
      else {
        startMs = startMs === undefined ? absolute : Math.min(startMs, absolute)
        endMs = endMs === undefined ? absolute + durationMs : Math.max(endMs, absolute + durationMs)
      }
      placed.push({
        key: `${segment.emitter}#${index}`,
        event,
        laneId,
        emitter: segment.emitter,
        index,
        ...(absolute !== undefined ? { startMs: absolute } : {}),
        durationMs,
      })
    })
  }

  // Lane order reads top-down the way the system runs: the agent, then where it was placed, then what it
  // drove — services alphabetically so the picture is stable across reloads.
  const lanes: Lane[] = [...counts.entries()]
    .map(([id, count]) => ({ id, kind: laneKindOf(id), label: laneLabelOf(id), count }))
    .sort((a, b) => laneRank(a) - laneRank(b) || a.label.localeCompare(b.label))

  return {
    lanes,
    placed,
    ...(startMs !== undefined && endMs !== undefined ? { axis: { startMs, endMs } } : {}),
    unanchored,
  }
}

function laneRank(lane: Lane): number {
  return lane.kind === 'agent' ? 0 : lane.kind === 'placement' ? 1 : 2
}
