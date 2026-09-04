import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { roundReading } from './round-reading'
import { campaignDecisionSchema, campaignListSchema, campaignSchema } from './schema'

// ── THE WEB'S DECODE, AGAINST BYTES A REAL CONTROL PLANE PRODUCED ───────────────────────────────────
//
// Everything else in this entity is checked against the contract's TYPES: the drift guards in `schema.ts`
// compare key sets and assignability at compile time, and they are what a type can prove. What a type cannot
// prove is what the ROUTE actually sends — and that is where this surface was wrong twice:
//
//   `GET /campaigns/:id/decision`   sends a union on `kind`. The web read `answer`, CAST rather than parsed,
//                                   so it was `undefined` at runtime and the settle button appeared on every
//                                   campaign whose gate was still saying continue.
//   `GET /campaigns/:id/adoption`   sends `{campaignId, state, operation}`. The web compared `operation` —
//                                   an OBJECT, or `null` on a campaign that authorized nothing — to a string.
//
// Both typechecked, linted and passed the unit suites. Neither could be caught by reading, so the payloads
// below were captured from a control plane booted with an empty env and driven end to end by
// `scripts/live/evolution-campaign.mjs` — the campaign was opened against a real issue, both sides ran as
// real batches, the rounds' verdicts were derived by the platform, it settled and the authorization was
// spent. Re-capture rather than hand-edit: a fixture somebody adjusted to pass is a fixture that has stopped
// answering the question.
const wire = JSON.parse(
  readFileSync(new URL('../../../../../../fixtures/campaign-wire.json', import.meta.url), 'utf8')
) as {
  list: unknown
  record: unknown
  recordFresh: unknown
  decisionAdopt: unknown
  decisionContinue: unknown
  adoption: { operation: { state: string; proof: { candidate: { version: string } } } }
  adoptionNone: { operation: null }
}

describe('decoding what the control plane actually sends', () => {
  it('decodes the campaign list and one full record', () => {
    expect(campaignListSchema.parse(wire.list).length).toBeGreaterThan(0)
    const c = campaignSchema.parse(wire.record)
    // The subject is on the FROZEN FRAME and its axis field is `type` — not `campaign.subject.kind`, which
    // is what the first version of this page rendered into a permanently blank header.
    expect(c.frame?.subject?.type).toBe('harness')
    expect(c.rounds.length).toBeGreaterThan(0)
  })

  it('reads a settled close as the tagged union it is', () => {
    const c = campaignSchema.parse(wire.record)
    expect(c.state).toBe('adopted')
    expect(c.close?.outcome.kind).toBe('adopted')
  })

  it('reads every round the walk logged, and derives the same reading the page draws', () => {
    const c = campaignSchema.parse(wire.record)
    const readings = c.rounds.map((r) => roundReading(r.verdict))
    // The live walk logged a neutral round and then a winning one, which is the shape the domain is built
    // around: a neutral candidate is a foundation, not a dead end.
    expect(readings.every((r) => r.kind === 'held_out')).toBe(true)
    const last = readings[readings.length - 1]
    expect(last?.kind === 'held_out' && last.improvements).toBeGreaterThan(0)
  })

  it('decodes BOTH gate answers — and refuses the field the first version read', () => {
    const adopt = campaignDecisionSchema.parse(wire.decisionAdopt)
    expect(adopt.kind).toBe('adopt')
    const cont = campaignDecisionSchema.parse(wire.decisionContinue)
    expect(cont.kind === 'continue' && typeof cont.roundsLeft).toBe('number')
    // …and the shape that was assumed is not the shape that arrives.
    expect(wire.decisionAdopt).not.toHaveProperty('answer')
  })

  it('reads the adoption operation as an object, and its absence as `null`', () => {
    // `decided` means the authorization exists and NOBODY HAS SPENT IT. Comparing this object to the string
    // 'decided' made every campaign read as already spent, which hid the whole owed-adoption callout.
    expect(typeof wire.adoption.operation).toBe('object')
    expect(wire.adoption.operation.state).toBe('registered')
    expect(wire.adoption.operation.proof.candidate.version).toBe('1.2.0')
    // A campaign that authorized nothing sends null — not a missing key, and not a string.
    expect(wire.adoptionNone.operation).toBeNull()
  })

  it('decodes a campaign with NO rounds and no close', () => {
    const fresh = campaignSchema.parse(wire.recordFresh)
    expect(fresh.rounds).toEqual([])
    expect(fresh.close).toBeUndefined()
  })
})
