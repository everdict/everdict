import { describe, expect, it } from 'vitest'

import { isUnmeasuredScore, scoreBadgeValue, scoreTone } from './format'

// The web's measured gate is a HAND-COPIED mirror of the contracts `isMeasured` (the web's @everdict dep is
// type-only, so the rule cannot be imported). This truth table pins the mirror to the contract's exact
// semantics — if the contract gate evolves, this file must change in lockstep (see contracts grader.ts).
// The contract's Score is a discriminated union on `status`, so the mirror reads the DISCRIMINANT and nothing
// else: the legacy detail-prose sentinels are resolved by the one reader-side normalizer in contracts and can
// no longer reach a browser, and a non-measurement arrives with no `value` at all.
describe('isUnmeasuredScore (contracts isMeasured mirror)', () => {
  it('reads the status discriminant — measured passes, unmeasured/invalid do not', () => {
    expect(isUnmeasuredScore({ status: 'measured' })).toBe(false)
    expect(isUnmeasuredScore({ status: 'unmeasured' })).toBe(true)
    expect(isUnmeasuredScore({ status: 'invalid' })).toBe(true)
  })

  it('treats an absent status as measured, exactly as the contract does', () => {
    expect(isUnmeasuredScore({})).toBe(false)
    expect(isUnmeasuredScore({ status: undefined })).toBe(false)
  })

  it('fails closed on a status it does not recognize', () => {
    // A future contract status must not reject the scorecard (the local schema stays loose), and it must not
    // render as a number either — a screen may not vouch for a measurement it cannot name.
    expect(isUnmeasuredScore({ status: 'partial' })).toBe(true)
  })

  it('never renders a value for a non-measurement, because there is none to render', () => {
    // The unmeasured variant carries no `value` field at all — the badge shows a dash, never a 0.
    expect(scoreBadgeValue({ metric: 'cost_usd' })).toBe('–')
    // …and a pass flag on a non-measurement is never a colour claim, whatever it says.
    expect(scoreTone({ status: 'unmeasured', pass: true })).toBe('neutral')
  })

  it('a measurement still renders its value and its verdict tone', () => {
    expect(scoreBadgeValue({ metric: 'tests_pass', value: 1, pass: true })).toBe('✓')
    expect(scoreTone({ pass: false })).toBe('danger')
  })
})
