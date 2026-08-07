import { describe, expect, it } from 'vitest'

import { judgeScoreDisplay } from './judge-preview-panel'

// The judge wizard's dry-run panel is the screen whose only job is "did my judge do what I meant?". The code
// judge — the authoring surface — validates a user's emitted scores against the control plane's full Score
// schema, and that schema's own error message instructs authors to emit a categorical verdict as
// {metric:'tier', value:3, label:'gold'}. So the preview MUST read the label; printing the ordering key tells
// the author their judge returned a number they never chose.
describe('judgeScoreDisplay — a categorical judge verdict reads as its answer', () => {
  it('prefers the label, so a tier verdict shows "gold" and not its ordering key', () => {
    // Given a categorical measurement exactly as the code judge's contract tells an author to emit it
    const score = { graderId: 'judge', metric: 'tier', value: 3, label: 'gold' }

    // Then the panel shows the answer — pre-fix it printed "3.00", the ordering key
    expect(judgeScoreDisplay(score)).toBe('gold')
  })

  it('falls back to the numeric value when the metric is not categorical', () => {
    expect(judgeScoreDisplay({ graderId: 'judge', metric: 'judge:q', value: 0.5 })).toBe('0.50')
  })

  it('an empty label is not an answer — the numeric value still reads', () => {
    expect(judgeScoreDisplay({ graderId: 'judge', metric: 'tier', value: 2, label: '' })).toBe('2.00')
  })

  it('a measurement with no value at all renders a dash, never a fabricated 0.00', () => {
    expect(judgeScoreDisplay({ graderId: 'judge', metric: 'judge:q' })).toBe('–')
  })
})
