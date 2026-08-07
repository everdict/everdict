import { describe, expect, it } from 'vitest'

import { scoreSchema } from './schema'

// The local score schema is a hand-written MIRROR of the contract's Score union, and the compile-time
// AssertAssignable guards next to it cannot protect it completely: an optional field the wire has and the
// mirror lacks is still assignable in BOTH directions, so the guards pass while `.parse()` silently strips
// the field. That failure mode has no compiler and no type error — only a test that parses a full wire row
// and checks what survived. Add a case here whenever the contract's Score grows a field.
describe('scoreSchema — a wire field the mirror forgets is silently stripped', () => {
  it('keeps `label`, so a categorical metric still reads as its tier and not its ordering key', () => {
    // Given a categorical measurement as the control plane serves it (label = the answer, value = the order)
    const parsed = scoreSchema.parse({
      graderId: 'judge',
      metric: 'tier',
      value: 3,
      label: 'gold',
      status: 'measured',
    })
    // Then the label survives the mirror — without it the run detail printed a bare "3"
    expect(parsed.label).toBe('gold')
  })

  it('keeps every field of the wire union — a non-measurement carries no value, only its cause', () => {
    const measured = scoreSchema.parse({
      graderId: 'tests-pass',
      metric: 'tests_pass',
      value: 1,
      pass: true,
      detail: { failed: [] },
      status: 'measured',
    })
    expect(measured).toEqual({
      graderId: 'tests-pass',
      metric: 'tests_pass',
      value: 1,
      pass: true,
      detail: { failed: [] },
      status: 'measured',
    })

    const unmeasured = scoreSchema.parse({
      graderId: 'judge',
      metric: 'judge:quality',
      status: 'unmeasured',
      reason: 'missing_secret',
      retryable: false,
      detail: 'skipped: no key',
    })
    expect(unmeasured).toEqual({
      graderId: 'judge',
      metric: 'judge:quality',
      status: 'unmeasured',
      reason: 'missing_secret',
      retryable: false,
      detail: 'skipped: no key',
    })
    // and there is no value to mis-render — the contract's unmeasured variant carries none at all
    expect('value' in unmeasured).toBe(false)
  })
})
