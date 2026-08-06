import { describe, expect, it } from 'vitest'

import type { TraceEvent } from '@/entities/run'

import { failureMessage, finalAnswer, totalCostUsd } from './trace'

// The trace-derived card facts, shared by the case card and the conversation turn card. Events are the loose
// passthrough shape the web parses, so the helpers must read fields defensively.

const events = [
  { t: 0, kind: 'message', role: 'user', text: 'hello' },
  { t: 1, kind: 'llm_call', model: 'm', cost: { inputTokens: 5, outputTokens: 1, usd: 0.01 } },
  { t: 2, kind: 'message', role: 'assistant', text: 'first' },
  {
    t: 3,
    kind: 'llm_call',
    model: 'aggregate',
    cost: { inputTokens: 0, outputTokens: 0, usd: 0.02 },
  },
  { t: 4, kind: 'message', role: 'assistant', text: '  the reply  ' },
] as TraceEvent[]

describe('playground trace helpers', () => {
  it('finalAnswer picks the LAST assistant message, trimmed, and skips user messages', () => {
    expect(finalAnswer(events)).toBe('the reply')
    expect(
      finalAnswer([{ t: 0, kind: 'message', role: 'user', text: 'x' }] as TraceEvent[])
    ).toBeUndefined()
  })

  it('totalCostUsd sums reported llm_call costs, and stays undefined when nothing reported one', () => {
    expect(totalCostUsd(events)).toBeCloseTo(0.03)
    expect(
      totalCostUsd([{ t: 0, kind: 'message', role: 'assistant', text: 'x' }] as TraceEvent[])
    ).toBeUndefined()
  })

  it('failureMessage surfaces the last error event in its own words', () => {
    const failed = [
      ...events,
      { t: 5, kind: 'error', message: ' claude exited with code 2 ' },
    ] as TraceEvent[]
    expect(failureMessage(failed)).toBe('claude exited with code 2')
    expect(failureMessage(events)).toBeUndefined()
  })
})
