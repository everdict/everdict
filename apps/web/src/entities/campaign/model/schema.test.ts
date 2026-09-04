import { describe, expect, it } from 'vitest'

import { roundReading, roundTone } from './round-reading'
import { campaignDecisionSchema, campaignSchema } from './schema'

// ── A CREATION RULE APPLIED AT DECODE TIME IS A DATA OUTAGE, ONE LAYER OUT ──────────────────────────
//
// `packages/contracts/src/records/legacy-campaign-decode.counterexample.test.ts` records the same defect in
// the control plane: ONE legacy row that fails to decode takes down the whole workspace's campaign list. The
// first version of this web schema reproduced it exactly — `learned` is `.optional()` on `CampaignRoundSchema`
// and required by the WRITE DTO only, and the web decodes rather than creates.
//
// The write floor (10..4000) lives in the form, which is where a creation rule belongs.

const legacyRound = {
  seq: 1,
  hypothesis: 'raise the tool budget',
  candidateVersion: '1.2.0',
  baselineScorecardId: 'sc-a',
  candidateScorecardId: 'sc-b',
  at: '2026-09-04T00:00:00.000Z',
  verdict: { comparable: true, significantImprovements: 1, significantRegressions: 0 },
}

describe('decoding a stored campaign', () => {
  it('reads a round written before `learned` was required', () => {
    const c = campaignSchema.parse({
      id: 'cmp-1',
      tenant: 'acme',
      issueId: 'iss-1',
      state: 'open',
      createdAt: '2026-09-04T00:00:00.000Z',
      rounds: [legacyRound],
    })
    expect(c.rounds[0]?.learned).toBeUndefined()
  })

  it('reads the subject off the FROZEN FRAME, by its `type` axis', () => {
    // Not `campaign.subject`, and not `.kind`. The record has neither; the frame the campaign froze at open
    // carries `{type, id, baselineVersion}`, and a page reading the other spelling renders a blank forever.
    const c = campaignSchema.parse({
      id: 'cmp-1',
      tenant: 'acme',
      state: 'open',
      frame: { subject: { type: 'harness', id: 'claude-code', baselineVersion: '1.0.0' } },
    })
    expect(c.frame?.subject?.type).toBe('harness')
  })

  it('reads the close as a TAGGED UNION — an adopted close names the version', () => {
    // Settling is not adopting: this says the gate decided, and the registry write stays owed until somebody
    // spends the authorization. The adopt panel keys on exactly this.
    const c = campaignSchema.parse({
      id: 'cmp-1',
      tenant: 'acme',
      state: 'adopted',
      close: {
        outcome: { kind: 'adopted', version: '1.3.0', provingScorecardId: 'sc-b' },
        at: '2026-09-04T01:00:00.000Z',
        by: 'someone',
      },
    })
    expect(c.close?.outcome.kind === 'adopted' && c.close.outcome.version).toBe('1.3.0')
  })
})

describe('what a round verdict says', () => {
  it('keeps "nobody derived one" apart from "it scored nothing"', () => {
    // A legacy row with no verdict block is not a judgement. `comparable: false` IS one — the round spent its
    // budget and measured nothing, which is precisely the round `learned` exists for.
    expect(roundReading(undefined).kind).toBe('unrecorded')
    expect(roundReading({ comparable: false }).kind).toBe('not_comparable')
  })

  it('reads the HELD-OUT block as the answer when it is there', () => {
    const r = roundReading({
      comparable: true,
      significantImprovements: 9,
      significantRegressions: 0,
      heldOut: { improvements: 2, regressions: 1 },
    })
    expect(r).toEqual({ kind: 'held_out', improvements: 2, regressions: 1 })
    // …and a held-out regression is the colour, however good the whole-round number looked.
    expect(roundTone(r)).toBe('danger')
  })

  it('refuses to colour a round the gate never read', () => {
    // Whole-round counts are feedback about the driver's SEARCH. A green badge over a measurement the gate
    // ignored is the page inventing a verdict — the same mistake as calling `not_comparable` a rejection.
    const r = roundReading({ comparable: true, significantImprovements: 5, significantRegressions: 0 })
    expect(r.kind).toBe('whole_round_only')
    expect(roundTone(r)).toBe('neutral')
  })
})

describe('the gate answer', () => {
  it('is one of exactly three, and refuses anything else', () => {
    // The arithmetic is the frame's. A free-form string would let the page render a fourth answer the record
    // has no rule for, and a reader would act on it.
    for (const answer of ['continue', 'adopt', 'halt'] as const)
      expect(campaignDecisionSchema.parse({ answer }).answer).toBe(answer)
    expect(() => campaignDecisionSchema.parse({ answer: 'probably' })).toThrow()
  })
})
