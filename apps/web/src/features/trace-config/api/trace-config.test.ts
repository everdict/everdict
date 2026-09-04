import { describe, expect, it } from 'vitest'

import { traceIngestionSchema, traceThresholdSchema } from './trace-config-shapes'

// The OTLP door's ceiling and the thresholds every trajectory is measured against — both applied on every
// seal and neither readable from the web until census slice 5, so a workspace could be silently dropping
// events past a quota nobody could see. docs/architecture/web-runtime-gap-census-spec.md
describe('trace config', () => {
  it('keeps NO CEILING apart from a number', () => {
    // `null` and `0` are different settings, and a schema that coerced null into a number would turn "no
    // ceiling" into "admit nothing" — the most destructive possible reading of an empty box.
    expect(traceIngestionSchema.parse({ maxEventsPerHour: null }).maxEventsPerHour).toBeNull()
    expect(traceIngestionSchema.parse({ maxEventsPerHour: 0 }).maxEventsPerHour).toBe(0)
  })

  it('refuses a metric the control plane has no rule for', () => {
    // A free-form string here would let the page save a threshold that can never fire, and it would look
    // saved.
    expect(() => traceThresholdSchema.parse({ name: 'x', metric: 'vibes', value: 1 })).toThrow()
    expect(traceThresholdSchema.parse({ name: 'x', metric: 'usd', value: 1 }).metric).toBe('usd')
  })

  it('refuses a negative threshold', () => {
    expect(() => traceThresholdSchema.parse({ name: 'x', metric: 'usd', value: -1 })).toThrow()
  })
})
