import { describe, expect, it } from 'vitest'

import type { TraceEvent } from '@/entities/trace'

import type { PlacedEvent } from './trajectory-planes'
import { trajectorySpans } from './trajectory-spans'

// The waterfall's fallback for a plane nothing could anchor. It reads `t` as a position, which only works if
// `t` starts near zero — and it does not: a harness stamping the wall clock puts an EPOCH in it, so the raw
// value drew every bar at the far right of a 57-year axis. Rebasing on the smallest one restores what the
// fallback always meant.

function placedOf(events: TraceEvent[]): PlacedEvent[] {
  return events.map((event, index) => ({
    key: `run#${index}`,
    event,
    laneId: 'agent',
    emitter: 'run',
    nodeId: `run#${index}`,
    index,
    durationMs: 0,
  }))
}

describe('projecting an unanchored trajectory onto waterfall nodes', () => {
  it('rebases wall-clock `t` so an unanchored plane still reads as a timeline', () => {
    const base = Date.parse('2026-08-03T06:26:56.416Z')
    const { nodes } = trajectorySpans(
      placedOf([
        { t: base, kind: 'message', role: 'user', text: 'go' },
        { t: base + 4_000, kind: 'tool_call', id: 'c1', name: 'search', args: {} },
        { t: base + 9_000, kind: 'message', role: 'assistant', text: 'done' },
      ])
    )

    expect(nodes.map((n) => n.startOffsetMs)).toEqual([0, 4_000, 9_000])
  })

  it('uses the real axis when the events were anchored', () => {
    const axisStart = Date.parse('2026-08-03T06:26:56.416Z')
    const placed = placedOf([{ t: 1, kind: 'message', role: 'assistant', text: 'done' }])
    const anchored = placed.map((p) => ({ ...p, startMs: axisStart + 2_500 }))

    const { nodes } = trajectorySpans(anchored, axisStart)
    expect(nodes[0]?.startOffsetMs).toBe(2_500)
  })
})
