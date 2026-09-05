import { describe, expect, it } from 'vitest'

import type { Run } from '@/entities/run'

import { buildActivityBlocks } from './blocks'

function run(overrides: Partial<Run> & { id: string; updatedAt: string }): Run {
  return {
    tenant: 'default',
    harness: { id: 'everdict-agent', version: '1.0.0' },
    caseId: 'chat',
    status: 'succeeded',
    createdAt: overrides.updatedAt,
    ...overrides,
  }
}

describe('buildActivityBlocks', () => {
  it('folds an agent conversation into ONE session block, turns in chronological order', () => {
    const standalone: Run[] = [
      // Three turns of the same conversation — the ledger delivers them newest first
      run({
        id: 't3',
        kind: 'agent',
        group: { id: 'conv-1', role: 'turn' },
        updatedAt: '2026-08-05T03:00:00Z',
      }),
      run({
        id: 't1',
        kind: 'agent',
        group: { id: 'conv-1', role: 'turn' },
        updatedAt: '2026-08-05T01:00:00Z',
      }),
      run({
        id: 't2',
        kind: 'agent',
        group: { id: 'conv-1', role: 'turn' },
        status: 'failed',
        updatedAt: '2026-08-05T02:00:00Z',
      }),
      // A standalone eval run that is not a conversation keeps its own row
      run({ id: 'e1', kind: 'eval', updatedAt: '2026-08-05T02:30:00Z' }),
    ]
    const blocks = buildActivityBlocks(standalone, [])
    expect(blocks.map((b) => b.kind)).toEqual(['session', 'run'])
    const session = blocks[0]
    if (session?.kind !== 'session') throw new Error('expected a session block')
    expect(session.session.id).toBe('conv-1')
    expect(session.session.count).toBe(3)
    // The header represents the newest turn's status and time, and the turns read in conversation order (1→n)
    expect(session.session.status).toBe('succeeded')
    expect(session.session.updatedAt).toBe('2026-08-05T03:00:00Z')
    expect(session.session.turns.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
  })

  it('does not fold playground cases or generic children — only role "turn" groups', () => {
    const standalone: Run[] = [
      run({
        id: 'p1',
        kind: 'eval',
        group: { id: 'sess-1', role: 'case' },
        updatedAt: '2026-08-05T01:00:00Z',
      }),
      run({
        id: 'c1',
        kind: 'agent',
        group: { id: 'parent', role: 'child' },
        updatedAt: '2026-08-05T01:10:00Z',
      }),
    ]
    const blocks = buildActivityBlocks(standalone, [])
    expect(blocks.map((b) => b.kind)).toEqual(['run', 'run'])
  })

  it('orders session blocks among runs and batches by recency of their latest turn', () => {
    const standalone: Run[] = [
      run({
        id: 't1',
        kind: 'agent',
        group: { id: 'conv-1', role: 'turn' },
        updatedAt: '2026-08-05T01:00:00Z',
      }),
      run({ id: 'e1', kind: 'eval', updatedAt: '2026-08-05T02:00:00Z' }),
    ]
    const blocks = buildActivityBlocks(standalone, [])
    expect(blocks.map((b) => b.kind)).toEqual(['run', 'session'])
  })
})
