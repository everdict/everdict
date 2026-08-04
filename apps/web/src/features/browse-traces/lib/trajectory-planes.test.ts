import { describe, expect, it } from 'vitest'

import type { TraceEvent } from '@/entities/trace'

import type { TrajectorySegment } from '../api/browse-trajectories'
import { placeTrajectory } from './trajectory-planes'

// A trajectory is laid on a wall clock, and the only thing that may put an event on it is that event's OWN
// absolute stamp. The alternative — adding `t` to whatever anchor the segment can find — reads a scalar whose
// unit nobody promised: a self-reported trace numbering its steps 1,2,3… had fifteen of them drawn inside the
// first fifteen MILLISECONDS of a twenty-three second run, because the infra plane's stamp anchored them.

function segment(events: TraceEvent[], emitter = 'run'): TrajectorySegment {
  return { emitter, source: 'run', eventCount: events.length, sealedAt: '', events }
}

const T0 = Date.parse('2026-08-03T06:26:56.416Z')

describe('placing a trajectory on the shared axis', () => {
  it('places a stamped agent event at its own instant, not at the anchor plus its step number', () => {
    // Given a plane whose steps are numbered but stamped, sharing a segment with an infra anchor
    const { placed, axis } = placeTrajectory([
      segment([
        { t: 1, at: new Date(T0 + 4_000).toISOString(), kind: 'tool_call', id: 'c1', name: 'search', args: {} },
        { t: 2, at: new Date(T0 + 9_000).toISOString(), kind: 'tool_result', id: 'c1', ok: true, output: 'ok' },
        { t: 0, kind: 'infra', scope: 'placement', event: 'leased', message: 'leased', at: new Date(T0).toISOString() },
      ]),
    ])

    // Then each step sits where it happened — 4s and 9s in, not 1ms and 2ms
    expect(placed[0]?.startMs).toBe(T0 + 4_000)
    expect(placed[1]?.startMs).toBe(T0 + 9_000)
    expect(axis?.startMs).toBe(T0)
  })

  it('never places an unstamped agent step with the INFRA plane’s anchor — two clocks, one segment', () => {
    // Given the shape that produced the bug: step numbers with no `at`, sharing a segment with an infra
    // event that does carry one (an agent `t` counts from the in-job t0, an infra `t` from dispatch)
    const { placed, unanchored } = placeTrajectory([
      segment([
        { t: 1, kind: 'tool_call', id: 'c1', name: 'search', args: {} },
        { t: 0, kind: 'infra', scope: 'placement', event: 'leased', message: 'leased', at: new Date(T0).toISOString() },
      ]),
    ])

    // Then the infra event still anchors the axis, and the numbered step is REPORTED as unplaceable
    // rather than silently drawn 1ms after the lease (which is what pre-fix did).
    expect(placed[1]?.startMs).toBe(T0)
    expect(placed[0]?.startMs).toBeUndefined()
    expect(unanchored).toBe(1)
  })

  it('places an unstamped step when the SEALER declared the plane’s t0 — that one speaks for every event', () => {
    const withT0: TrajectorySegment = {
      ...segment([{ t: 1_500, kind: 'message', role: 'assistant', text: 'done' }]),
      t0: new Date(T0).toISOString(),
    }
    const { placed } = placeTrajectory([withT0])
    expect(placed[0]?.startMs).toBe(T0 + 1_500)
  })

  it('leaves a whole unstamped plane unanchored when nothing in it can be dated', () => {
    const { placed, axis, unanchored } = placeTrajectory([
      segment([
        { t: 1, kind: 'tool_call', id: 'c1', name: 'search', args: {} },
        { t: 2, kind: 'tool_result', id: 'c1', ok: true, output: 'ok' },
      ]),
    ])

    expect(axis).toBeUndefined()
    expect(unanchored).toBe(2)
    expect(placed.every((p) => p.startMs === undefined)).toBe(true)
  })

  it('reads the call/result span edges a stamping harness now emits', () => {
    const { placed } = placeTrajectory([
      segment([
        { t: 1, kind: 'tool_call', id: 'c1', name: 'search', args: {}, spanId: 'c1' },
        { t: 2, kind: 'tool_result', id: 'c1', ok: true, output: 'ok', parentId: 'c1' },
      ]),
    ])

    expect(placed[0]?.nodeId).toBe('run:c1')
    expect(placed[1]?.parentNodeId).toBe('run:c1') // the result hangs under the call it answers
  })
})
