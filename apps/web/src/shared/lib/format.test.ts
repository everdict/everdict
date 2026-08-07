import { describe, expect, it } from 'vitest'

import { isUnmeasuredScore } from './format'

// The web's measured gate is a HAND-COPIED mirror of the contracts `isMeasured` (the web's @everdict dep is
// type-only, so the rule cannot be imported). This truth table pins the mirror to the contract's exact
// semantics — if the contract gate evolves, this file must change in lockstep (see contracts grader.ts).
describe('isUnmeasuredScore (contracts isMeasured mirror)', () => {
  it('reads the modern status stamp first — measured passes, unmeasured/invalid do not', () => {
    expect(isUnmeasuredScore({ status: 'measured' })).toBe(false)
    expect(isUnmeasuredScore({ status: 'unmeasured' })).toBe(true)
    expect(isUnmeasuredScore({ status: 'invalid' })).toBe(true)
  })

  it('treats a legacy sentinel row (no status, no pass, sentinel detail) as unmeasured', () => {
    expect(isUnmeasuredScore({ detail: '[grader-error] judge transport died' })).toBe(true)
    expect(isUnmeasuredScore({ detail: 'skipped: missing ANTHROPIC_API_KEY' })).toBe(true)
  })

  it('keeps a real measurement whose prose merely opens like a sentinel — pass present wins', () => {
    // Both legacy unmeasured producers left `pass` undefined; a measurement carrying a pass verdict is a
    // measurement no matter how its prose detail begins. Same rule as the contracts gate.
    expect(isUnmeasuredScore({ pass: true, detail: 'skipped: 3 optional steps' })).toBe(false)
    expect(isUnmeasuredScore({ pass: false, detail: '[grader-error] quoted in the reasoning' })).toBe(false)
  })

  it('a status stamp overrides the sentinel reading in both directions', () => {
    expect(isUnmeasuredScore({ status: 'measured', detail: '[grader-error] quoted prose' })).toBe(false)
    expect(isUnmeasuredScore({ status: 'unmeasured', pass: true })).toBe(true)
  })

  it('plain rows without status or sentinel are measured', () => {
    expect(isUnmeasuredScore({})).toBe(false)
    expect(isUnmeasuredScore({ pass: true })).toBe(false)
    expect(isUnmeasuredScore({ detail: 'looks good' })).toBe(false)
    expect(isUnmeasuredScore({ detail: { structured: true } })).toBe(false)
  })
})
