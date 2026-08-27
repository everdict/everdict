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
const CampaignFrameShape = z.object({
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
  // …and whether this campaign may adopt a candidate it can only name by LABEL (arch-review 72 P1-medium).
  // Default FALSE: a scorecard that sealed no spec digest cannot prove which bytes it measured, and adopting
  // on that is exactly the C1-evaluated/C2-saved substitution with nothing to catch it.
  allowLabelOnlyAdoption: z.boolean().default(false),
  // ── WHAT A JUDGE'S OBSERVATION VERDICT COSTS THIS CAMPAIGN (arch-review 71 P1-evolution) ────────
  //
  // A judge shown the platform's own observation account answers whether the trace's claims and that
  // account agree. `divergent` is the judge saying the candidate's story does not match what the platform
  // watched it do — the strongest negative evidence the system can produce — and it could not reach this
  // decision, because it lived in rendered prose.
  //
  // Frozen with the rest of the frame: a policy chosen after seeing the rounds is not a policy.
  observationPolicy: z
    .object({
      // Default FALSE. Adopting a candidate whose own judge says its account diverges from the observed
      // world is the claim this product exists to refuse.
      allowDivergent: z.boolean().default(false),
      // …and how much of the round must actually have been LOOKED AT, as a fraction of the measured scores
      // that could carry an assessment. Absent = no requirement, which is what every campaign had: a
      // deployment that wants "the candidate's account was independently checked" to mean something says so.
      minimumCoverage: z.number().min(0).max(1).optional(),
      // `unclear` is neither arm — a bound on how much of it a round may carry before the evidence stops
      // meaning anything. Absent = unbounded, which is what every campaign had.
      maxUnclear: z.number().int().min(0).optional(),
    })
    .default({}),
});
// ── THE DISCIPLINE IS ENFORCED HERE, NOT DESCRIBED (arch-review 71 P1-high) ────────────────────────
//
// The comment above said "the skill's discipline (>=2 held out) is authored here once and then immutable"
// and the schema required `scenarios.min(1)` with `heldOut` defaulting to false. So a campaign with zero
// held-out scenarios was valid, and the gate — which never read `heldOut` either — adopted on training
// gains. An annotation the validator does not enforce and the decision does not read is documentation.
//
// Two, not one: a single case that moved is exactly what a loop optimizing against a small set produces
// by chance, so one held-out scenario is a coin flip wearing the word evidence.
//
// Ids are unique because the gate compares scenario-id SETS across the two sides, and duplicates make that
// comparison weaker than it reads as — and make "how many held-out scenarios are there" unanswerable.
// ── WHAT MAY BE CREATED, AND WHAT MAY BE READ BACK, ARE TWO QUESTIONS (arch-review 72 P1) ─────────
//
// The held-out rule below is right and it was applied in the wrong place: ONE schema served both creation
// and STORAGE DECODE, so a campaign written before the rule existed stopped parsing — and `list()` maps
// every row, so a single legacy campaign took down a whole workspace's list. A policy change became an
// availability regression, and it shipped.
//
// `docs/migration/` already has the shape: expand → deploy → contract. Tightening the WRITE path is the
// expand; tightening the READ path in the same change is the contract, and doing both at once breaks rows
// that were valid when they were written.
//
// A legacy frame reads back as what it WAS — no held-out flags are invented, because guessing them would
// manufacture the very evidence the rule exists to require. It is simply not adoption evidence: the gate
// already refuses a round with no `heldOut` block, so the decision stays fail-closed without this schema
// having to lie about the past.
export const StoredCampaignFrameSchema = CampaignFrameShape;
export type StoredCampaignFrame = z.infer<typeof StoredCampaignFrameSchema>;

// ── ONE PREDICATE, TWO CONSUMERS: THE CREATION SCHEMA AND THE DECISION PATH (arch-review 75) ────────
//
// Reading a legacy frame is right; letting it produce NEW adoption evidence is not. A campaign stored with
// one held-out scenario (or duplicate ids) is still `open`, and nothing stopped it logging a fresh round
// after the upgrade — that round carries a `heldOut` block derived from the frame's single flag, the gate
// asks only `improvements >= 1 && regressions === 0`, and the campaign adopts on evidence the current rule
// exists to forbid. The legacy-decode test's "a legacy campaign is not adoption evidence" was true only of
// rows written BEFORE the upgrade.
//
// So the rule is exported as a predicate the creation schema and the decision path both consume. Written
// twice it would already have diverged (rule `protocol` L3); written once, tightening it tightens both.
export function campaignFrameDefects(frame: { scenarios: ReadonlyArray<{ id: string; heldOut?: boolean }> }): string[] {
  const defects: string[] = [];
  const ids = frame.scenarios.map((s) => s.id);
  if (new Set(ids).size !== ids.length)
    defects.push("scenario ids must be unique — the gate compares the two sides by id set");
  const held = frame.scenarios.filter((s) => s.heldOut === true).length;
  if (held < 2)
    defects.push(`a campaign needs at least 2 held-out scenarios to have adoption evidence (this frame has ${held})`);
  return defects;
}

// The CREATION schema: the shape above plus the discipline a NEW campaign must satisfy.
export const CampaignFrameSchema = CampaignFrameShape.superRefine((frame, ctx) => {
  for (const message of campaignFrameDefects(frame)) ctx.addIssue({ code: "custom", path: ["scenarios"], message });
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
    // ── …AND THE HELD-OUT POPULATION, COUNTED APART (arch-review 71 P1-high) ───────────────────────
    //
    // The counts above are the whole round, and the gate won on them — so a candidate that improved only
    // where the loop had been pushing adopted. That is the loop grading the homework it was optimizing
    // against, which is the single thing a held-out set exists to prevent.
    //
    // Held-out is where the claim has to hold, so it is counted separately and it is what the gate reads.
    // Optional for the rows written before this existed: a round that cannot say is not adoption evidence,
    // which `campaignAdoption` enforces rather than assuming.
    heldOut: z
      .object({
        improvements: z.number().int().min(0),
        regressions: z.number().int().min(0),
      })
      .optional(),
    // ── THE EXACT BYTES THIS ROUND EVALUATED (arch-review 71 P0-evolution) ─────────────────────────
    //
    // The round names a candidate VERSION, which is a label. Two different specs can wear one label — a
    // candidate C1 is evaluated, C2 is saved under the same `id@version`, and the campaign has nothing to
    // tell them apart with. Every later proof rests on this join, so it is recorded where the evaluation
    // happened rather than reconstructed at adoption time (L3: provenance is born at the source).
    //
    // Taken from the candidate scorecard's OWN sealed manifest — the digest of the spec that batch ran.
    // Optional because a built-in harness has no declarative spec to digest, and for the rows written
    // before this existed; `campaignAdoption` decides what an absent one is worth.
    candidateSpecDigest: z.string().optional(),
    // …and what the judges said about the candidate's account of itself (arch-review 71 P1-evolution).
    // Counted over the CANDIDATE side: the question is whether the thing being adopted tells the truth about
    // what it did. Optional for the rows written before this existed.
    observations: z
      .object({
        divergent: z.number().int().min(0),
        unclear: z.number().int().min(0),
        // ── COVERAGE, BECAUSE MISSING IS NOT CONSISTENT (arch-review 72 P2) ────────────────────────
        //
        // Counting only divergent and unclear made two very different rounds identical: one where every
        // observation-aware judge answered "consistent", and one where NO judge recorded an assessment at
        // all. Both read `divergent: 0, unclear: 0`, and a gate cannot tell "checked and clean" from "never
        // checked" — which is the annotation failure this whole review series is about, in the evidence
        // rather than in the wiring.
        // ⚠️ OPTIONAL, because a round written before these existed is a round that was legitimately
        // stored (arch-review 75). Making them required tightened the READ path for a rule that belongs to
        // the write path — the same "a creation rule applied at decode time is a data outage" defect
        // arch-review 72 closed for the FRAME, reproduced one level down by the change that closed it.
        // `list()` maps every row through this schema, so one legacy round takes down a workspace's whole
        // campaign list.
        //
        // Absent is UNKNOWN COVERAGE, never zero and never clean: `campaignAdoption` refuses a round with no
        // coverage block whenever the frame demanded coverage. Backfilling numbers here would manufacture
        // exactly the evidence the policy exists to require.
        assessed: z.number().int().min(0).optional(),
        eligible: z.number().int().min(0).optional(),
      })
      .optional(),
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
      // …and WHICH BYTES that version was when it was proved (arch-review 71 P0-evolution). A close that
      // names only a label cannot be checked against what a registry later holds under that label.
      candidateSpecDigest: z.string().optional(),
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

// ── THE DECISION, IN A FORM AN EFFECT CAN BE HELD TO (arch-review 71 P0-evolution) ─────────────────
//
// A campaign closed `adopted` and executed nothing. The MCP tool told the caller to go run `save_agent` or
// `register_harness` afterwards — generic authoring APIs with no campaign id, no frame digest, no round
// sequence, no candidate digest and no gate answer — so four states were reachable and all of them silent:
//
//     settle → crash                 adopted, and no capability anywhere
//     save with no gate              a capability with no adoption authority
//     C1 evaluated, C2 saved         one version label over two different specs
//     adopted, issue unresolved      the decision and its intent came apart
//
//     CampaignGateAnswer exists   ≠   a registry effect consumed it
//
// This is the value that closes the gap: everything an effect needs to prove it is the one this campaign
// authorized, minted where the decision is made and never re-derived downstream (L3). `gateDigest` covers
// the answer itself, so a proof cannot be edited into authorizing something else.
// ── THE CANDIDATE, NORMALIZED ON THE WAY IN (arch-review 75) ───────────────────────────────────────
//
// `identity` was added in arch-review 72 and made REQUIRED, which turned every operation written before it
// into a row that cannot be read — the same "a creation rule applied at decode time is a data outage"
// defect arch-review 72 itself closed for the frame, reproduced one level down by the change that closed
// it. `PgAdoptionOperationStore` parses whatever the ledger holds, so a legacy row breaks the adoption
// read for that campaign.
//
// The repair is a NORMALIZATION rather than an optional field: `exact` MEANS the proof named bytes, so
// `specDigest !== undefined` is the same predicate the minter applies — deriving it on read is not a
// guess, and it is the only way downstream stays unable to confuse a weak proof with a strong one. An
// optional `identity` would have handed every consumer a third case and reopened arch-review 72's finding.
const AdoptionCandidateShape = z.object({
  type: z.enum(["agent", "harness"]),
  id: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
  // The bytes, not the label (arch-review 71). Absent for a built-in with no declarative spec.
  specDigest: z.string().optional(),
  // ── HOW STRONG THIS PROOF IS, SAID OUT LOUD (arch-review 72 P1-medium) ──────────────────────────
  //
  // `specDigest` being optional meant an adoption that named exact bytes and one that named only a version
  // LABEL were the same value to every reader: same `adopted` state, same `decided` operation, no way to
  // see which one you had. A weak proof that reads like a strong one is the annotation failure this review
  // series is named for.
  //
  // So the strength is a field, and a label-only adoption is only legal when the frame RECORDED that it
  // would be (`allowLabelOnlyAdoption`) — a decision made before any round was seen.
  identity: z.enum(["exact", "label_only"]),
});

export const AdoptionCandidateSchema = z.preprocess((value) => {
  if (typeof value !== "object" || value === null) return value;
  const candidate = value as Record<string, unknown>;
  if (candidate.identity !== undefined) return candidate;
  return { ...candidate, identity: candidate.specDigest === undefined ? "label_only" : "exact" };
}, AdoptionCandidateShape);

export const CampaignAdoptionProofSchema = z.object({
  campaignId: z.string().min(1),
  // The frozen exam this decision was made under. A proof whose frame digest no longer matches the campaign
  // is a proof about a different experiment.
  frameDigest: z.string().min(1),
  // WHICH round proved it — the trace position, so a later round cannot borrow an earlier answer.
  roundSeq: z.number().int().min(1),
  candidate: AdoptionCandidateSchema,
  provingScorecardId: z.string().min(1),
  // The issue this campaign was opened against, carried so the effect and the intent cannot come apart.
  issueId: z.string().min(1),
  gateDigest: z.string().min(1),
});
export type CampaignAdoptionProof = z.infer<typeof CampaignAdoptionProofSchema>;

// ── AND THE OPERATION THAT OWES THE EFFECT ────────────────────────────────────────────────────────
//
// The close is a decision; this is the debt it creates. Written in the SAME transaction as the close (the
// store's `close` takes it), so `adopted` and "somebody owes a registration" are one durable fact — the
// atomic-seam law this repository just spent two waves on, applied to the feature that needed it most.
//
// `decided` is the state a crash leaves behind, and it is the whole point: an operation nobody has consumed
// is visible, addressable and re-drivable, where a campaign that merely said `adopted` was none of those.
export const AdoptionOperationStateSchema = z.enum(["decided", "registered", "completed"]);
export type AdoptionOperationState = z.infer<typeof AdoptionOperationStateSchema>;

export const AdoptionOperationSchema = z.object({
  operationId: z.string().min(1),
  tenant: z.string().min(1),
  proof: CampaignAdoptionProofSchema,
  state: AdoptionOperationStateSchema,
  // What actually consumed it, stamped when the registry write landed — so "registered" names a version
  // somebody can go look at rather than asserting one happened.
  registeredVersion: z.string().max(100).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdoptionOperation = z.infer<typeof AdoptionOperationSchema>;

export const EvolutionCampaignRecordSchema = z.object({
  id: z.string().min(1),
  tenant: z.string().min(1),
  // The intent hub. The issue journals the narrative, links the scorecards, and carries the resolution /
  // regression watch; the campaign references it rather than duplicating any of that.
  issueId: z.string().min(1),
  frame: StoredCampaignFrameSchema,
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
