import type {
  CampaignClose,
  CampaignRound,
  CampaignSubject,
  EvolutionCampaignRecord,
} from '@everdict/contracts'
import { z } from 'zod'

// ── AN EVOLUTION CAMPAIGN, AS A READER MEETS IT ────────────────────────────────────────────────────
//
// `GET /campaigns/:id` sends the STORED RECORD verbatim, so this file DECODES; it never creates. The two
// questions are different and the first version of this file answered them with one schema:
//
//     what may be CREATED    the write DTO's floor — `learned` 10..4000, required. That belongs to the FORM.
//     what may be READ BACK  whatever was legitimately stored before that rule existed.
//
// `learned` is OPTIONAL on the row (`CampaignRoundSchema`), and `list()` maps every row through this. One
// legacy round with none would have taken down the whole workspace's campaign list — the outage
// `packages/contracts/src/records/legacy-campaign-decode.counterexample.test.ts` was written for, reproduced
// one layer out in the browser. So this file is permissive by construction, and the guards at the bottom
// are what keep it honest against the contract.
// docs/architecture/web-runtime-gap-census-spec.md · skill `evolve`

export const campaignSubjectSchema = z.object({
  // `type`, not `kind` — the axis the frame freezes: agent | harness | environment.
  type: z.string(),
  id: z.string(),
  baselineVersion: z.string().optional(),
})

// DERIVED by the platform from the production scorecard diff — never sent by the driver, which is why a loop
// cannot write its own report card.
//
// ⚠️ `comparable: false` is NOT an absent verdict. It is the round that scored nothing and still spent its
// budget, and drawing the two the same way hides the round `learned` exists for.
export const campaignVerdictSchema = z.object({
  comparable: z.boolean(),
  significantImprovements: z.number().optional(),
  significantRegressions: z.number().optional(),
  // HELD-OUT IS WHAT DECIDES. Whole-round counts are feedback about the driver's SEARCH; the gate reads this
  // block, which is why the page draws it as the answer and the whole-round numbers as diagnosis.
  heldOut: z
    .object({ improvements: z.number().optional(), regressions: z.number().optional() })
    .optional(),
})

export const campaignRoundSchema = z.object({
  seq: z.number().int(),
  hypothesis: z.string().optional(),
  // The half that survives the round: the verdict is derived and the budget is spent either way, so what the
  // round TAUGHT is the only thing the next one can use. Optional HERE because the row allows it; required by
  // the form, which is where the creation rule belongs.
  learned: z.string().optional(),
  candidateVersion: z.string().optional(),
  at: z.string().optional(),
  verdict: campaignVerdictSchema.optional(),
})
export type CampaignRoundView = z.infer<typeof campaignRoundSchema>

// The close — the gate's answer made durable. `adopted` names the version and the scorecard that proved it;
// a halt carries the reason the gate gave, and the two are a tagged union rather than a string.
export const campaignCloseSchema = z.object({
  outcome: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('adopted'),
      version: z.string(),
      provingScorecardId: z.string().optional(),
    }),
    z.object({
      kind: z.literal('halted'),
      reason: z.string(),
      detail: z.string().optional(),
    }),
  ]),
  at: z.string().optional(),
  by: z.string().optional(),
})

export const campaignSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  issueId: z.string().optional(),
  // The frozen frame, read as an opaque record apart from the subject: its fields are sealed by digest at
  // open, and a second copy of their shape here would be a spelling that can drift from the one that decides.
  frame: z.looseObject({ subject: campaignSubjectSchema.optional() }).optional(),
  state: z.string(),
  rounds: z.array(campaignRoundSchema).default([]),
  createdBy: z.string().optional(),
  createdAt: z.string().optional(),
  // A close reading `adopted` while nobody has spent the authorization is NOT a bug — settling is not
  // adopting, and the registry write stays owed until somebody does it.
  close: campaignCloseSchema.optional(),
})
export type CampaignView = z.infer<typeof campaignSchema>
export const campaignListSchema = z.array(campaignSchema.omit({ rounds: true }))

// The gate's answer, ASKED rather than computed — a reader who counted rounds themselves would be answering a
// different question from the one the frame asks.
//
// ⚠️ It is a union discriminated on `kind`, and the first version of this file called it `answer`. Nothing
// caught that: the read was CAST rather than parsed, so `decision.answer` was `undefined` at runtime and
// `undefined !== 'continue'` offered a settle button on every campaign the gate was still saying continue to
// — the exact state the button is hidden to prevent. Only driving it against a live control plane found it,
// which is why the payloads are now a fixture (`fixtures/campaign-wire.json`) and this read is parsed.
//
// `CampaignGateAnswer` lives in `@everdict/domain`, which the web may not import, so there is no drift guard
// for this one — the fixture is what stands in for it.
export const campaignDecisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('adopt'),
    version: z.string(),
    provingScorecardId: z.string().optional(),
    waivedAxes: z.array(z.string()).default([]),
  }),
  // Real numbers a driver acts on: how many rounds the budget still allows, and how long the rejected streak
  // is. Both are the frame's arithmetic, which is the reason to render them rather than recompute them.
  z.object({
    kind: z.literal('continue'),
    roundsLeft: z.number().optional(),
    consecutiveRejected: z.number().optional(),
  }),
  z.object({
    kind: z.literal('halt'),
    reason: z.string(),
    detail: z.string().optional(),
  }),
])
export type CampaignDecision = z.infer<typeof campaignDecisionSchema>

// ── THE GUARDS ─────────────────────────────────────────────────────────────────────────────────────
//
// Written because the first version of this file got the wire wrong FOUR times in one sitting — a `close`
// with an `answer`, a `verdict` with an `outcome`, a `subject` on the record instead of on the frame, and a
// required `learned`. Every one of them typechecked, ran, and rendered nothing: three permanently blank
// readings and one outage. Prose could not have caught them, because prose is what produced them.
//
// So there are two directions, and they catch different mistakes:
//
//   KEYS      every field this file declares EXISTS on the wire. Structural assignability cannot see an
//             invented optional (an extra property is simply ignored), so the key sets are compared directly.
//   SHAPE     the wire's own type is assignable to what this file decodes — which fails the moment the web
//             REQUIRES something the row may legitimately omit.
type AssertAssignable<A extends B, B> = A

type _campaignKeys = AssertAssignable<keyof CampaignView, keyof EvolutionCampaignRecord>
type _roundKeys = AssertAssignable<keyof CampaignRoundView, keyof CampaignRound>
type _closeKeys = AssertAssignable<keyof z.infer<typeof campaignCloseSchema>, keyof CampaignClose>
type _subjectKeys = AssertAssignable<keyof z.infer<typeof campaignSubjectSchema>, keyof CampaignSubject>

type _roundShape = AssertAssignable<CampaignRound, CampaignRoundView>
type _closeShape = AssertAssignable<CampaignClose, z.infer<typeof campaignCloseSchema>>
type _subjectShape = AssertAssignable<CampaignSubject, z.infer<typeof campaignSubjectSchema>>

export type __campaignDriftGuard = [
  _campaignKeys,
  _roundKeys,
  _closeKeys,
  _subjectKeys,
  _roundShape,
  _closeShape,
  _subjectShape,
]
