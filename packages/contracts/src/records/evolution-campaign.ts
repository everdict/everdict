import { z } from "zod";

// ── THE CAMPAIGN IS A SETTLEMENT (docs/architecture/evolution-lineage.md, Track D) ───────────────────
//
// The agent-evolve loop's discipline — frozen scenario/judge/trial frame, a budget stated up front, stop
// after consecutive rejected rounds, adopt only on significant-improvement-with-zero-regressions — was
// prose in a skill body, enforced by nobody, journaled in a markdown log the loop itself edits. A decision
// (adoption) rested on a journal. This record is the settlement half: the FRAME is frozen at open and
// referenced by digest thereafter (L4 — the loop cannot weaken its own judges, scenarios or thresholds
// mid-campaign), the ROUNDS are an append-only trace of every hypothesis tested, and the close carries the
// pure adoption gate's answer. The ISSUE stays beside it as the narrative journal and the intent-stratum
// hub — the record holds exactly what an issue cannot: frozen bytes and a derived state.

// What one campaign optimizes: candidate VERSIONS of one capability family, against a fixed baseline.
export const CampaignSubjectSchema = z.object({
  type: z.enum(["agent", "harness"]),
  id: z.string().min(1).max(200),
  baselineVersion: z.string().min(1).max(100),
});
export type CampaignSubject = z.infer<typeof CampaignSubjectSchema>;

// The frozen half of the campaign. Everything the adoption decision depends on is HERE, at open — a value
// that arrived later would be a rule the loop chose after seeing the data.
export const CampaignFrameSchema = z.object({
  subject: CampaignSubjectSchema,
  // Scenario/case ids, with the held-out ones marked. The skill's discipline (≥2 held out) is authored
  // here once and then immutable.
  scenarios: z
    .array(z.object({ id: z.string().min(1).max(300), heldOut: z.boolean().default(false) }))
    .min(1)
    .max(500),
  judges: z.array(z.string().min(1).max(200)).default([]),
  trialsPerCase: z.number().int().min(1).max(100),
  // The budget is ROUNDS: one round = one hypothesis = one baseline↔candidate comparison. Trials/scenarios
  // are fixed above, so rounds is the axis a runaway loop spends on.
  budget: z.object({ maxRounds: z.number().int().min(1).max(1000) }),
  stopAfterRejectedRounds: z.number().int().min(1).max(100).default(3),
  // Significance settings, frozen with everything else the verdict depends on.
  significance: z
    .object({
      fdrAlpha: z.number().gt(0).lt(1).optional(),
      minDelta: z.number().min(0).max(1).optional(),
    })
    .default({}),
  // The RECORDED waiver for adopting over an unverified world-identity axis. Absent/false = the gate
  // refuses (`identity_unverified`) — an optimization verdict on an unverifiable world is the claim this
  // product exists to prevent.
  allowUnverifiedIdentity: z.boolean().default(false),
});
export type CampaignFrame = z.infer<typeof CampaignFrameSchema>;

// One hypothesis tested. The verdict is DERIVED by the service from the one production diff predicate
// (trials significance + experiment identity) — never accepted from the caller, which would let the loop
// write its own report card (L3).
export const CampaignRoundSchema = z.object({
  seq: z.number().int().min(1), // 1-based append position; the store enforces contiguity
  hypothesis: z.string().min(1).max(2000),
  candidateVersion: z.string().min(1).max(100),
  baselineScorecardId: z.string().min(1),
  candidateScorecardId: z.string().min(1),
  verdict: z.object({
    // false = the pair could not be compared at all (policy mismatch, no trial signal) — such a round can
    // never adopt and counts as rejected; the detail says why.
    comparable: z.boolean(),
    significantImprovements: z.number().int().min(0),
    significantRegressions: z.number().int().min(0),
    // Experiment-identity axes the diff could not verify (execution_world, …). Non-empty blocks adoption
    // unless the frame recorded the waiver at open.
    unverifiedAxes: z.array(z.string().max(100)).default([]),
    // Axes the diff VERIFIED as different (a confound — e.g. two resolved but different image digests).
    // Stronger than unverified and never waivable here: a delta across different worlds is not evidence
    // about the change under test, so a confounded round records the axes and is not comparable.
    confoundedAxes: z.array(z.string().max(100)).default([]),
    detail: z.string().max(1000).optional(),
  }),
  at: z.string(),
  by: z.string().min(1),
});
export type CampaignRound = z.infer<typeof CampaignRoundSchema>;

export const CAMPAIGN_STATES = ["open", "adopted", "no_improvement", "budget_exhausted"] as const;
export const CampaignStateSchema = z.enum(CAMPAIGN_STATES);
export type CampaignState = z.infer<typeof CampaignStateSchema>;

// The close — the gate's answer made durable. `adopted` carries the version and the proving scorecard
// (the same pair an issue resolution names); a halt carries the reason the gate gave.
export const CampaignCloseSchema = z.object({
  outcome: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("adopted"),
      version: z.string().min(1),
      provingScorecardId: z.string().min(1),
      // Identity axes adoption proceeded over under the frame's recorded waiver — empty on a clean adopt.
      waivedAxes: z.array(z.string().max(100)).default([]),
    }),
    z.object({
      kind: z.literal("halted"),
      reason: z.enum(["no_improvement", "budget_exhausted"]),
      detail: z.string().max(1000),
    }),
  ]),
  at: z.string(),
  by: z.string().min(1),
});
export type CampaignClose = z.infer<typeof CampaignCloseSchema>;

export const EvolutionCampaignRecordSchema = z.object({
  id: z.string().min(1),
  tenant: z.string().min(1),
  // The intent hub. The issue journals the narrative, links the scorecards, and carries the resolution /
  // regression watch; the campaign references it rather than duplicating any of that.
  issueId: z.string().min(1),
  frame: CampaignFrameSchema,
  // contentDigest of the frame at open — what an adoption references, and what makes a frame edit
  // representable only as a NEW campaign.
  frameDigest: z.string().min(1),
  rounds: z.array(CampaignRoundSchema).default([]),
  state: CampaignStateSchema,
  close: CampaignCloseSchema.optional(),
  createdBy: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EvolutionCampaignRecord = z.infer<typeof EvolutionCampaignRecordSchema>;
