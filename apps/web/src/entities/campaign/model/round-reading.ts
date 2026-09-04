import type { CampaignRoundView } from './schema'

// ── WHAT A ROUND'S DERIVED VERDICT ACTUALLY SAYS ───────────────────────────────────────────────────
//
// Four readings, not two, and the distinctions are the domain's rather than the layout's — which is why this
// is a function a test can drive instead of a ternary in JSX.
//
//   unrecorded         a legacy row with no verdict block. Nobody derived one; that is not a judgement.
//   not_comparable     `comparable: false`. The round scored NOTHING and spent its budget anyway — the round
//                      `learned` exists for. Drawing it like an unrecorded one hides exactly that.
//   held_out           HELD-OUT IS WHAT DECIDES (skill `evolve`). This is the block the gate reads.
//   whole_round_only   comparable, but no held-out block — a legacy round, or a frame that never had one.
//                      Whole-round counts are feedback about the driver's SEARCH, so they are shown as
//                      diagnosis and never as the answer.
export type RoundReading =
  | { kind: 'unrecorded' }
  | { kind: 'not_comparable' }
  | { kind: 'held_out'; improvements: number; regressions: number }
  | { kind: 'whole_round_only'; improvements: number; regressions: number }

export function roundReading(verdict: CampaignRoundView['verdict']): RoundReading {
  if (verdict === undefined) return { kind: 'unrecorded' }
  if (!verdict.comparable) return { kind: 'not_comparable' }
  const held = verdict.heldOut
  if (held !== undefined)
    return {
      kind: 'held_out',
      improvements: held.improvements ?? 0,
      regressions: held.regressions ?? 0,
    }
  return {
    kind: 'whole_round_only',
    improvements: verdict.significantImprovements ?? 0,
    regressions: verdict.significantRegressions ?? 0,
  }
}

// Only a held-out block earns a colour. A whole-round-only round reads NEUTRAL however good its numbers look:
// the gate did not read them, and a green badge over a measurement the gate ignored is the page inventing a
// verdict — the same mistake as collapsing `not_comparable` into "rejected".
export function roundTone(reading: RoundReading): 'success' | 'danger' | 'neutral' {
  if (reading.kind !== 'held_out') return 'neutral'
  if (reading.regressions > 0) return 'danger'
  return reading.improvements > 0 ? 'success' : 'neutral'
}
