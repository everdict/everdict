import { describe, expect, it } from 'vitest'

import type { Cycle } from '../model/schema'

import {
  activeCycleOf,
  cycleHref,
  cycleIndexHref,
  cycleLengthDays,
  cycleStateOf,
  daysRemaining,
  landingCycleOf,
  nextCycleOf,
} from './cycle-view'

// 2026-08-03 is a Monday.
const TODAY = '2026-08-03'

function cycle(over: Partial<Cycle> = {}): Cycle {
  return {
    id: over.id ?? 'c1',
    tenant: 'acme',
    teamId: 'team-eng',
    number: over.number ?? 1,
    startsAt: '2026-08-03',
    endsAt: '2026-08-16',
    history: [],
    createdBy: 'dana',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...over,
  }
}

describe('cycleStateOf — the state is read, never stored', () => {
  it('is upcoming before the window and active from its first day', () => {
    expect(cycleStateOf(cycle(), '2026-08-02')).toBe('upcoming')
    expect(cycleStateOf(cycle(), TODAY)).toBe('active')
  })

  it('keeps a cycle nobody closed ACTIVE past its end date — a forgotten cycle is not a finished one', () => {
    expect(cycleStateOf(cycle(), '2026-09-01')).toBe('active')
  })

  it('is completed only on an explicit close', () => {
    expect(cycleStateOf(cycle({ completedAt: '2026-08-10T00:00:00.000Z' }), TODAY)).toBe('completed')
  })
})

describe('landingCycleOf — what the team sees when it opens Cycles', () => {
  const running = cycle({ id: 'c2', number: 2 })
  const ahead = cycle({ id: 'c3', number: 3, startsAt: '2026-08-17', endsAt: '2026-08-30' })
  const past = cycle({
    id: 'c1',
    number: 1,
    startsAt: '2026-07-20',
    endsAt: '2026-08-02',
    completedAt: '2026-08-02T00:00:00.000Z',
  })

  it('opens the iteration the team is in', () => {
    expect(landingCycleOf([ahead, running, past], TODAY)?.id).toBe('c2')
    expect(activeCycleOf([ahead, running, past], TODAY)?.id).toBe('c2')
  })

  it('falls back to the next one when none is running', () => {
    expect(landingCycleOf([ahead, past], TODAY)?.id).toBe('c3')
    expect(nextCycleOf([ahead, past], TODAY)?.id).toBe('c3')
  })

  it('falls back to the most recent one when everything is behind the team', () => {
    expect(landingCycleOf([past], TODAY)?.id).toBe('c1')
  })

  it('has nothing to open for a team with no cycles', () => {
    expect(landingCycleOf([], TODAY)).toBeUndefined()
  })
})

describe('daysRemaining', () => {
  it('counts today as a day the team still has', () => {
    expect(daysRemaining(cycle(), TODAY)).toBe(14)
    expect(daysRemaining(cycle(), '2026-08-16')).toBe(1)
  })

  it('is zero past the end date rather than negative', () => {
    expect(daysRemaining(cycle(), '2026-08-17')).toBe(0)
  })

  it('measures the whole window of an upcoming cycle, not the wait before it', () => {
    expect(daysRemaining(cycle(), '2026-07-01')).toBe(14)
  })
})

describe('cycleLengthDays', () => {
  it('counts both ends of the window', () => {
    expect(cycleLengthDays(cycle())).toBe(14)
    expect(cycleLengthDays(cycle({ endsAt: '2026-08-03' }))).toBe(1)
  })
})

describe('cycle addresses', () => {
  it('addresses a cycle by its NUMBER under the owning team', () => {
    expect(cycleHref('acme', 'ENG', 7)).toBe('/acme/teams/ENG/cycles/7')
    expect(cycleIndexHref('acme', 'ENG')).toBe('/acme/teams/ENG/cycles/all')
  })
})
