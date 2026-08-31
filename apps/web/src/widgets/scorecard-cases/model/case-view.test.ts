import { describe, expect, it } from 'vitest'

import { findCaseEvidence, type CaseScoreEvidence } from './case-view'

// A case's evidence (judge rationale, unmeasured reason) arrives separately when the dialog opens — which
// created a rule for deciding which score row an arriving piece belongs to, and that rule is all this file
// is. The first spelling of it was a Record keyed by `${graderId}:${metric}`; grader names are chosen by the
// workspace and judge metrics are already spelled `judge:<id>`, so two different scores collide on one key.
// Judge A's rationale then sits silently under judge B's row.

const evidence: CaseScoreEvidence[] = [
  { graderId: 'judge', metric: 'style:tone', detail: 'judge · the tone criterion rationale' },
  { graderId: 'judge:style', metric: 'tone', detail: 'a different grader entirely' },
  { graderId: 'tests', metric: 'pass', reason: 'the grader process died' },
]

describe('case score evidence — matched on grader AND metric, never on a joined key', () => {
  it('is the collision a joined key would have made', () => {
    // How two scores come to have one name — the reason this test exists.
    expect(`judge:style:tone`).toBe(`${'judge'}:${'style:tone'}`)
    expect(`judge:style:tone`).toBe(`${'judge:style'}:${'tone'}`)
  })

  it('gives each of those two scores its own rationale', () => {
    expect(findCaseEvidence(evidence, { graderId: 'judge', metric: 'style:tone' })?.detail).toBe(
      'judge · the tone criterion rationale'
    )
    expect(findCaseEvidence(evidence, { graderId: 'judge:style', metric: 'tone' })?.detail).toBe(
      'a different grader entirely'
    )
  })

  it('carries the unmeasured reason on the score that could not be measured', () => {
    expect(findCaseEvidence(evidence, { graderId: 'tests', metric: 'pass' })?.reason).toBe(
      'the grader process died'
    )
  })

  it('answers nothing for a score with no evidence — and while none has arrived yet', () => {
    expect(findCaseEvidence(evidence, { graderId: 'tests', metric: 'coverage' })).toBeUndefined()
    expect(findCaseEvidence(undefined, { graderId: 'tests', metric: 'pass' })).toBeUndefined()
  })
})
