import { describe, expect, it } from 'vitest'

import { caseResultSchema } from './schema'

// The local case-result schema is a hand-written, deliberately-loose MIRROR of the contract's CaseResult,
// and the compile-time drift guards cannot protect it: an OPTIONAL field the wire has and the mirror lacks
// is assignable in both directions, so the guards pass while `.parse()` silently strips it. The execution
// manifest is exactly that shape — optional, additive, and invisible when dropped. Add a case here whenever
// CaseResult grows a field the web reads.
describe('caseResultSchema — the execution manifest survives the mirror', () => {
  const base = { caseId: 'c1', harness: 'claude-code@1.0.0', scores: [], trace: [] }

  it('keeps the world a case ran in, including whether the OS was authored', () => {
    // Given a result as the control plane serves it, carrying the manifest run-case recorded
    const parsed = caseResultSchema.parse({
      ...base,
      execution: {
        os: 'windows',
        osResolved: 'declared',
        driver: 'docker',
        image: 'ghcr.io/acme/win:1',
      },
    })
    // Then every field survives — a stripped manifest would make the detail strip vanish with no error
    expect(parsed.execution).toEqual({
      os: 'windows',
      osResolved: 'declared',
      driver: 'docker',
      image: 'ghcr.io/acme/win:1',
    })
  })

  it('keeps the topology lane manifest, which names a runtime and no driver', () => {
    const parsed = caseResultSchema.parse({
      ...base,
      execution: { os: 'linux', osResolved: 'defaulted', runtime: 'nomad-seoul' },
    })
    expect(parsed.execution?.runtime).toBe('nomad-seoul')
    expect(parsed.execution?.driver).toBeUndefined()
  })

  it('leaves the manifest absent for a result nobody recorded a world for', () => {
    // A synthesized dispatch failure / an ingested trace ran in no world at all. Absence must stay absence:
    // defaulting it to linux here would re-invent the exact fabrication the manifest exists to prevent.
    const parsed = caseResultSchema.parse(base)
    expect(parsed.execution).toBeUndefined()
  })
})
