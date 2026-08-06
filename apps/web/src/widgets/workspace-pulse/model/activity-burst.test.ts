import { describe, expect, it } from 'vitest'

import type { PlatformEvent } from '@/entities/platform-event'

import { collapseActivityBursts } from './activity-burst'

// The home feed is the newest N facts — and one agent publishing a dozen files in a turn used to BE
// the whole feed, hiding every other member behind it. These lock in that a burst is one line.

let seq = 0
function evt(overrides: Partial<PlatformEvent>): PlatformEvent {
  seq += 1
  return {
    id: `evt-${seq}`,
    seq,
    tenant: 'acme',
    kind: 'file.published',
    subject: { type: 'file', id: `memory/${seq}.md` },
    payload: {},
    message: 'recorded',
    createdAt: '2026-08-06T10:00:00.000Z',
    ...overrides,
  }
}

describe('collapseActivityBursts', () => {
  it('folds a consecutive same-actor same-kind run into one row that counts the rest', () => {
    const bursts = collapseActivityBursts([
      evt({ actor: 'agent-key' }),
      evt({ actor: 'agent-key' }),
      evt({ actor: 'agent-key' }),
      evt({ actor: 'dana', kind: 'comment.created', subject: { type: 'issue', id: 'iss-1' } }),
    ])
    expect(bursts).toHaveLength(2)
    expect(bursts[0]?.event.id).toBe('evt-1') // newest-first input: the first of the run leads
    expect(bursts[0]?.more).toBe(2)
    expect(bursts[1]?.event.actor).toBe('dana')
    expect(bursts[1]?.more).toBe(0)
  })

  it('keeps interleaved actors and kinds as separate lines — collapse never re-orders time', () => {
    const bursts = collapseActivityBursts([
      evt({ actor: 'agent-key' }),
      evt({ actor: 'dana' }),
      evt({ actor: 'agent-key' }),
    ])
    expect(bursts).toHaveLength(3)
    expect(bursts.every((b) => b.more === 0)).toBe(true)
  })

  it('splits the same actor across different kinds', () => {
    const bursts = collapseActivityBursts([
      evt({ actor: 'dana', kind: 'issue.created', subject: { type: 'issue', id: 'iss-1' } }),
      evt({ actor: 'dana', kind: 'issue.status_changed', subject: { type: 'issue', id: 'iss-1' } }),
    ])
    expect(bursts).toHaveLength(2)
  })

  it('groups actor-less events by what caused them, and unattributed ones together', () => {
    const agentRun = collapseActivityBursts([
      evt({ causedBy: 'agent:a1:c1' }),
      evt({ causedBy: 'agent:a1:c1' }),
      evt({ causedBy: 'agent:a2:c9' }),
    ])
    expect(agentRun).toHaveLength(2)
    expect(agentRun[0]?.more).toBe(1)

    const system = collapseActivityBursts([
      evt({ kind: 'schedule.fired', subject: { type: 'schedule', id: 's1' } }),
      evt({ kind: 'schedule.fired', subject: { type: 'schedule', id: 's2' } }),
    ])
    expect(system).toHaveLength(1)
    expect(system[0]?.more).toBe(1)
  })
})
