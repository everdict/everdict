import { describe, expect, it } from 'vitest'

import { deltaArrow, metricDelta } from './metric-delta'

// The delta is the one piece of arithmetic the product does on the agent's behalf, and every way it can be
// wrong still renders a confident-looking card: a flipped sign, a good/bad the wrong way round, or points
// quoted as percent. None of that is visible in a screenshot, so it is pinned here instead.

const fmt = (value: number) => `${Math.round(value * 100) / 100}`

describe('metric delta', () => {
  it('reports a ratio move in percentage POINTS, so the reader can check it against the two values shown', () => {
    // 58.2% → 62.4% is +4.2 points. Quoting the +7.2% RELATIVE change here would be a number that appears
    // nowhere on the card.
    expect(
      metricDelta({ label: 'Pass rate', value: 0.624, unit: 'ratio', baseline: 0.582 }, fmt)
    ).toEqual({
      direction: 'up',
      sentiment: 'good',
      magnitude: '4.2pt',
    })
  })

  it('reports every other unit as a relative percent, the way a cost change is discussed', () => {
    expect(
      metricDelta({ label: 'Cost', value: 0.284, unit: 'usd', baseline: 0.241 }, fmt)?.magnitude
    ).toBe('17.8%')
  })

  it('colors by MEANING, not by the sign: a rising cost is a regression', () => {
    const rising = metricDelta(
      { label: 'Cost', value: 0.284, unit: 'usd', baseline: 0.241, higherIsBetter: false },
      fmt
    )
    expect(rising).toEqual({ direction: 'up', sentiment: 'bad', magnitude: '17.8%' })

    const falling = metricDelta(
      { label: 'Cost', value: 0.241, unit: 'usd', baseline: 0.284, higherIsBetter: false },
      fmt
    )
    expect(falling).toEqual({ direction: 'down', sentiment: 'good', magnitude: '15.1%' })
  })

  it('treats an omitted higherIsBetter as "up is good", never as unknown', () => {
    expect(
      metricDelta({ label: 'Cases', value: 12, unit: 'count', baseline: 10 }, fmt)?.sentiment
    ).toBe('good')
  })

  it('makes no claim about movement when there is no baseline', () => {
    expect(metricDelta({ label: 'Cases', value: 300 }, fmt)).toBeNull()
  })

  it('calls a move that would render as 0.0 flat, rather than inventing a direction', () => {
    expect(metricDelta({ label: 'x', value: 100.02, unit: 'count', baseline: 100 }, fmt)).toEqual({
      direction: 'flat',
      sentiment: 'neutral',
      magnitude: '0.0%',
    })
    expect(
      metricDelta({ label: 'x', value: 0.5, unit: 'ratio', baseline: 0.5 }, fmt)?.direction
    ).toBe('flat')
  })

  it('falls back to the absolute difference when the baseline is zero (no relative form exists)', () => {
    expect(metricDelta({ label: 'Failures', value: 3, unit: 'count', baseline: 0 }, fmt)).toEqual({
      direction: 'up',
      sentiment: 'good',
      magnitude: '3',
    })
  })

  it('keeps the direction from the difference when the baseline is negative, not from the quotient', () => {
    expect(metricDelta({ label: 'x', value: -5, unit: 'raw', baseline: -10 }, fmt)).toEqual({
      direction: 'up',
      sentiment: 'good',
      magnitude: '50.0%',
    })
  })

  it('maps arrows to DIRECTION — the color carries the sentiment, the glyph does not', () => {
    expect([deltaArrow('up'), deltaArrow('down'), deltaArrow('flat')]).toEqual(['▲', '▼', '—'])
  })
})
