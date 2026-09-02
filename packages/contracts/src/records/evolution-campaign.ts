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
  // ── A CHAIN REUSES THE HELD-OUT SET, AND THE FAMILY HAS TO SPAN THE CHAIN ────────────────────────
  //
  // One campaign ends. The obvious next move is another one starting from what it adopted, and that is what
  // "keeps improving" means here — a walk is a chain of campaigns, not a campaign that runs forever.
  //
  // Declared rather than inferred, because the honest version is not the convenience. `heldOutFamilySize`
  // corrects the tests one campaign spends against its frozen held-out rows; a successor reusing THOSE ROWS
  // spends more tests against the same population, and a per-campaign family cannot see them. So the link is
  // frozen in the frame (it rides the digest), and the service verifies at open what a pure predicate cannot:
  // the predecessor adopted, this campaign starts from the version it adopted, the held-out set is the same
  // exam, the pre-registration is the same, and the whole chain's rounds still fit inside it.
  //
  // Absent = a fresh walk, whose family covers only itself. That is the correct default and the one every
  // campaign written before this had.
  continues: z.string().min(1).max(200).optional(),
  // Scenario/case ids, with the held-out ones marked. The skill's discipline (≥2 held out) is authored
  // here once and then immutable.
  scenarios: z
    .array(z.object({ id: z.string().min(1).max(300), heldOut: z.boolean().default(false) }))
    .min(1)
    .max(500),
  // ── THE CASES THIS CAMPAIGN EXISTS TO FLIP (docs/architecture/evolution-routing-spec.md §3) ───────
  //
  // An issue says "these cases fail". A campaign opened against it used to be judged on the AGGREGATE held-out
  // block, so a candidate that improved five OTHER held-out cases adopted while the five the issue named still
  // failed — "the actual issue was resolved" was never asked. `targets` are scenario ids the loop is briefed on
  // and optimizes against, so they are NOT held-out (a case the loop is shown is not a generalization
  // population by any meaning of the word); the gate requires every one of them to flip, and the held-out
  // block to regress nowhere. Default empty = the aggregate rule, which every campaign written before had.
  targets: z.array(z.string().min(1).max(300)).max(500).default([]),
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
      // ── THE HELD-OUT SET IS CONSUMED BY BEING ASKED, AND NOTHING WAS COUNTING ────────────────────
      //
      // `fdrAlpha` corrects across the CASES of one round: Benjamini-Hochberg over the family of per-case
      // tests, which is right and is the whole family the diff can see. A campaign asks a SECOND family of
      // questions the diff cannot see — the same frozen held-out population, once per round, with any single
      // round able to end the walk by adopting.
      //
      // So a null candidate has ~H x alpha/2 chance of winning a given round (H held-out cases), and a
      // ten-round campaign at alpha 0.05 over three held-out cases adopts something by chance about half the
      // time. `budget.maxRounds` bounds that, and a budget is a spending cap, not a statistical statement:
      // it says when to stop paying, not what the answer means.
      //
      // This is the family size, PRE-REGISTERED. The round verdict is derived at `fdrAlpha / this`, so every
      // round of one campaign is judged by one rule frozen before any data was seen — a level chosen after
      // the rounds is not a level. It is at least `budget.maxRounds` (every round consults the held-out set,
      // so the budget IS the minimum family), and larger when the same held-out population will be carried
      // into follow-up campaigns: chaining reuses the set, so the family spans the chain.
      //
      // It costs trials, and that is the honest price rather than a defect: at alpha 0.05 over 10 rounds a
      // round is judged at 0.005, and 0/5 -> 5/5 is Fisher p = 0.0079, so N=5 no longer clears it. A campaign
      // that wants ten rounds buys about seven trials a side. The old behaviour bought the rounds and
      // reported the price as evidence.
      heldOutFamilySize: z.number().int().min(1).max(10000).optional(),
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
  // ── THE ORACLE IS A SET OF REPOSITORY PATHS (docs/architecture/code-evolution-loop.md, D3) ────────
  //
  // A candidate produced by a coding agent with a checkout can edit the dataset, the judge rubric or the
  // graders' tests as easily as the scaffold — the candidate rewriting its own exam. These path patterns
  // (`tests/`, `evals/**`, `judges/rubric-*.md`; the language is `pathMatchesPattern` in `@everdict/domain`)
  // freeze the boundary at open. Non-empty means every round's candidate pull request is read and a change
  // inside the scope makes the round non-comparable ("oracle touched"); a change that cannot be read makes it
  // non-comparable too, because "could not check" is not "clean". Empty = no boundary declared, which is what
  // every campaign before this had.
  oracleScope: z.array(z.string().min(1).max(300)).max(100).default([]),
  // ── THE DELEGATION BUDGET (docs/architecture/code-evolution-loop.md, delegation budget) ──────────
  //
  // Rounds are bounded; the coding agent a round delegates to was not. Declared, the round door requires the
  // sandbox session that produced the candidate (`delegationRunId`) and refuses the round when that session's
  // TTL exceeded `ttlSec` or its metered spend exceeded `maxUsd` — read off the RUN LEDGER, never from the
  // caller. Absent = no delegation budget, which is what every campaign before this had.
  delegation: z
    .object({
      ttlSec: z.number().int().positive(),
      maxUsd: z.number().nonnegative().optional(),
    })
    .optional(),
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
export function campaignFrameDefects(frame: {
  scenarios: ReadonlyArray<{ id: string; heldOut?: boolean }>;
  targets?: ReadonlyArray<string>;
  budget: { maxRounds: number };
  significance: { fdrAlpha?: number; heldOutFamilySize?: number };
}): string[] {
  const defects: string[] = [];
  const ids = frame.scenarios.map((s) => s.id);
  if (new Set(ids).size !== ids.length)
    defects.push("scenario ids must be unique — the gate compares the two sides by id set");
  // Targets are scenarios, named once, and never held-out: the gate reads both blocks, and a case in both would
  // be counted as the thing the loop optimizes against AND the population that says whether it generalized.
  const targets = frame.targets ?? [];
  if (new Set(targets).size !== targets.length) defects.push("target ids must be unique");
  const scenarioById = new Map(frame.scenarios.map((s) => [s.id, s] as const));
  const foreign = targets.filter((t) => !scenarioById.has(t));
  if (foreign.length > 0) defects.push(`targets must be frame scenarios — not in scenarios: ${foreign.join(", ")}`);
  const heldTargets = targets.filter((t) => scenarioById.get(t)?.heldOut === true);
  if (heldTargets.length > 0)
    defects.push(
      `a target is a case the loop is briefed on and optimizes against, so it cannot also be held-out: ${heldTargets.join(", ")}`,
    );
  const held = frame.scenarios.filter((s) => s.heldOut === true).length;
  if (held < 2)
    defects.push(`a campaign needs at least 2 held-out scenarios to have adoption evidence (this frame has ${held})`);
  // …and the level it is judged at, plus how many times it may be asked. Both are frozen for the same
  // reason the scenarios are: a threshold chosen after seeing the rounds is not a threshold.
  if (frame.significance.fdrAlpha === undefined)
    defects.push(
      "significance.fdrAlpha must be declared — a campaign whose significance level is whatever the diff defaults to has not frozen the value its verdict depends on",
    );
  const family = frame.significance.heldOutFamilySize;
  if (family === undefined)
    defects.push(
      "significance.heldOutFamilySize must be declared — the held-out set is tested once per round and nothing corrects for that unless the family is pre-registered (budget.maxRounds is the floor)",
    );
  else if (family < frame.budget.maxRounds)
    defects.push(
      `significance.heldOutFamilySize (${family}) is below budget.maxRounds (${frame.budget.maxRounds}) — every round consults the held-out set, so a family smaller than the budget corrects for fewer tests than this campaign is allowed to run`,
    );
  return defects;
}

// The CREATION schema: the shape above plus the discipline a NEW campaign must satisfy.
export const CampaignFrameSchema = CampaignFrameShape.superRefine((frame, ctx) => {
  for (const message of campaignFrameDefects(frame)) ctx.addIssue({ code: "custom", path: ["scenarios"], message });
});
export type CampaignFrame = z.infer<typeof CampaignFrameSchema>;

// ── A FRAME DERIVED FROM THE ISSUE (docs/architecture/evolution-routing-spec.md §3) ─────────────────
//
// The caller states everything BUT the exam: `scenarios` and `targets` come from the issue's `case` links —
// the linked cases are the targets, the linked dataset version's every other case is held-out. The service
// performs the derivation (it needs the issue and the dataset) through `frameFromCases` in `@everdict/domain`,
// and the result is parsed through `CampaignFrameSchema`, so a derived frame meets every creation rule a
// hand-written one does. `fromIssue: true` is the discriminator a body carries to ask for this.
export const CampaignFrameFromIssueSchema = CampaignFrameShape.omit({ scenarios: true, targets: true }).extend({
  fromIssue: z.literal(true),
});
export type CampaignFrameFromIssue = z.infer<typeof CampaignFrameFromIssueSchema>;

// ── WHERE A CANDIDATE CAME FROM (docs/architecture/code-evolution-loop.md, D4) ───────────────────────
//
// A round named a `candidateVersion` and nothing else, so the chain "delegation session → pull request → sha
// → image → scorecard → round" lived in four records and was joined in none. These are the candidate
// SCORECARD's origin coordinates, copied by the service from that record — never accepted from the caller
// (L3). `source` rides along because it says who authored them: a `github-actions` origin is CI's word under
// OIDC federation, an `api` or `mcp` one is the submitter's. Optional wherever it appears: rows written before
// this existed, and candidates whose scorecard carried no origin, have none.
export const CandidateSourceSchema = z.object({
  source: z.string().min(1),
  repo: z.string().optional(), // "owner/name"
  sha: z.string().optional(),
  ref: z.string().optional(), // refs/heads/… | refs/pull/…
  prNumber: z.number().int().optional(),
  runUrl: z.string().optional(), // the CI run that built and evaluated it
  pinOverrides: z.record(z.string()).optional(), // submit-time ephemeral pins (slot → image), when the batch swapped one
  // ── WHEN EVERDICT BUILT THE CANDIDATE ITSELF (docs/architecture/code-evolution-loop.md, D2) ───────
  //
  // `source: "everdict-build"`: the coordinates above came from the campaign's own BUILD record — the commit
  // Everdict checked out and observed (`git rev-parse HEAD` in the build session), the image it published
  // and the base it published it on. Everdict's word about bytes it produced, which outranks a scorecard
  // origin's caller-authored coordinates whenever both exist for one candidate version.
  image: z.string().optional(), // the candidate image, digest-pinned, in the managed store
  baseImage: z.string().optional(), // the slot's image the build extended
  buildId: z.string().optional(),
});
export type CandidateSource = z.infer<typeof CandidateSourceSchema>;

// ── A CANDIDATE BUILT BY EVERDICT (docs/architecture/code-evolution-loop.md, D2) ─────────────────────
//
// The campaign's own record of turning a commit into a candidate: which slot, from which repository at which
// commit, on which base, into which image, minted as which instance version. Born `building` when the build
// session starts and settled `built` or `failed` by the build itself — never by the caller. `logRound` reads
// a `built` record whose `candidateVersion` is the round's candidate and fills `candidateSource` from it.
export const CampaignBuildStateSchema = z.enum(["building", "built", "failed"]);
export type CampaignBuildState = z.infer<typeof CampaignBuildStateSchema>;

export const CampaignBuildRecordSchema = z.object({
  id: z.string().min(1),
  tenant: z.string().min(1),
  campaignId: z.string().min(1),
  slot: z.string().min(1), // the template service name, or "image" for a command harness
  source: z.object({
    git: z.string().min(1),
    repo: z.string().optional(), // "owner/name"
    ref: z.string().optional(), // what the caller asked to check out (branch, tag or sha)
    sha: z.string().optional(), // what the build OBSERVED checked out — written by the build, not the caller
    prNumber: z.number().int().optional(),
  }),
  base: z.object({ version: z.string().min(1), image: z.string().min(1) }), // the instance version and slot image extended
  state: CampaignBuildStateSchema,
  sessionRunId: z.string().optional(), // the build session (a sandbox run) — its trajectory is the build log
  image: z.object({ repository: z.string(), tag: z.string(), ref: z.string(), digest: z.string() }).optional(),
  candidateVersion: z.string().optional(), // the instance version minted from the digest
  receipt: z
    .object({
      steps: z.array(z.string()),
      stepsDigest: z.string(),
      workDir: z.string(),
      capture: z.array(z.string()),
      startedAt: z.string(),
      finishedAt: z.string(),
    })
    .optional(),
  error: z.string().max(4000).optional(),
  createdBy: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CampaignBuildRecord = z.infer<typeof CampaignBuildRecordSchema>;

// One hypothesis tested. The verdict is DERIVED by the service from the one production diff predicate
// (trials significance + experiment identity) — never accepted from the caller, which would let the loop
// write its own report card (L3).
export const CampaignRoundSchema = z.object({
  seq: z.number().int().min(1), // 1-based append position; the store enforces contiguity
  hypothesis: z.string().min(1).max(2000),
  // ── WHAT THE ROUND TAUGHT, WHICH IS NOT WHAT IT SCORED ──────────────────────────────────────────
  //
  // The trace recorded what was TRIED (`hypothesis`) and what the platform DERIVED (`verdict`), and nothing
  // recorded what the walk now knows. So a rejected round was pure spend: its budget was gone and its lesson
  // lived only in whatever prose a human wrote beside it. A campaign that rejects nineteen candidates has
  // learned nineteen things and could not hand one of them to round twenty.
  //
  // WikiSkill (arXiv 2608.27454) measured what that costs. Giving the PROPOSER a knowledge layer that
  // survives rollback moved their benchmark from 43.8% to 63.7% — the single largest effect in the paper,
  // larger than the skill evolution it was supporting. Their layer is a patch-edited wiki; ours is this
  // field, append-only with the round, because a document the loop may rewrite is a document the loop can
  // use to revise its own history (L4), and we already have an append-only trace to hang it on.
  //
  // ⚠️ IT IS ADVICE, NEVER EVIDENCE. `campaignAdoption` does not read it and must not: this is the one value
  // on the round the LOOP authors about itself, and the whole point of deriving the verdict is that the loop
  // cannot write its own report card (L3). The counterexample pins that — the gate's answer is identical with
  // it and without it. What it feeds is the next PROPOSAL, which is a different question from what decides.
  //
  // Most valuable on a round that could not be compared at all: that round scores nothing, spends a round of
  // the budget, and is the one most likely to know why.
  learned: z.string().max(4000).optional(),
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
    // The frame's `targets`, answered one by one (evolution-routing-spec.md §3): `flipped` improved significantly
    // on the candidate, `unflipped` did not. Present exactly when the frame declares targets; absent on rounds
    // of a frame without them and on rows written before the field existed — the gate reads its presence as the
    // frame's, never as the data's.
    targets: z
      .object({
        flipped: z.array(z.string().min(1).max(300)),
        unflipped: z.array(z.string().min(1).max(300)),
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
    // …and where those bytes came from — the candidate scorecard's origin, platform-copied (D4 above).
    candidateSource: CandidateSourceSchema.optional(),
    // …and which oracle paths the candidate's pull request touched, when the frame declared a scope and the
    // change fell inside it (D3). Present only on such a round; the round is then `comparable: false`.
    oracleTouched: z.array(z.string().max(300)).optional(),
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
  // ── THE DELEGATION SESSION THAT PRODUCED THE CANDIDATE, AS THE LEDGER RECORDS IT ─────────────────
  //
  // The caller names the sandbox run; the platform copies what the run ledger says about it — its TTL and its
  // metered spend — so the round's account of what the delegate cost is the ledger's, not the loop's (L3).
  // Present when the round named a session; REQUIRED by the write when the frame declared a delegation budget.
  delegation: z
    .object({
      runId: z.string().min(1).max(200),
      ttlSec: z.number().int().positive().optional(),
      usd: z.number().nonnegative().optional(),
    })
    .optional(),
  at: z.string(),
  by: z.string().min(1),
});
export type CampaignRound = z.infer<typeof CampaignRoundSchema>;

// ── THE CALLER-AUTHORED HALF OF A ROUND, WITH THE RECORD'S BOUNDS ────────────────────────────────────
//
// The HTTP DTO bounded these fields and the MCP twin did not, and the service appended the round literal
// unparsed. Rows are read back through `EvolutionCampaignRecordSchema` — `PgEvolutionCampaignStore` parses
// every row, and `list()` maps every row — so one empty hypothesis or one 4001-character finding logged over
// MCP made that campaign, and the workspace's whole campaign list, unreadable. The same "a rule applied at
// decode time is a data outage" shape arch-review 72/75 closed, entered through the door the agent loop
// actually drives.
//
// So the bounds are declared ONCE, as a projection of the record schema, and the write validates against
// them whichever door the round came through. A transport may tighten (the DTO requires `learned` of a new
// round); it may not loosen, because this is what the row can hold.
export const CampaignRoundInputSchema = CampaignRoundSchema.pick({
  hypothesis: true,
  learned: true,
  candidateVersion: true,
  baselineScorecardId: true,
  candidateScorecardId: true,
}).extend({
  // The sandbox session that produced this candidate — the caller NAMES it; what it cost is read off the run
  // ledger by the service and recorded as `round.delegation`. Required by the write when the frame budgets
  // the delegation.
  delegationRunId: z.string().min(1).max(200).optional(),
});
export type CampaignRoundInput = z.infer<typeof CampaignRoundInputSchema>;

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
      // …and which commit / pull request those bytes were built from, when the round's scorecard said (D4).
      candidateSource: CandidateSourceSchema.optional(),
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
  // Where the proved bytes were built from (D4) — what a later MERGE effect will need to name the pull request
  // it merges (docs/architecture/code-evolution-loop.md, D5). Optional: a candidate without an origin has none.
  candidateSource: CandidateSourceSchema.optional(),
  // The issue this campaign was opened against, carried so the effect and the intent cannot come apart.
  issueId: z.string().min(1),
  // …and the team that owned the campaign when it decided. Carried on the PROOF so a registry write can be
  // gated against the authority that was frozen at open rather than against whatever the entity's team
  // happens to be at the moment somebody spends it (arch-review 76 P1-security).
  teamId: z.string().min(1).optional(),
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

// ── THE CODE HALF OF AN ADOPTION (docs/architecture/code-evolution-loop.md, D5) ──────────────────────
//
// An adoption registers the BYTES the round measured. When those bytes were built from a pull request (the
// proof's `candidateSource` names it), the code that produced them is still a branch, and the next campaign's
// baseline image and the default branch diverge until it is merged. That merge is a second effect the close
// owes, tracked here as its own sub-lifecycle rather than a fourth operation state: `completed` is about the
// ISSUE, this is about the REPOSITORY, and folding them would make "issue closed" and "code landed" one word.
//
// Born `owed` at settle, from the proof — never from the caller; `merged` is written by the merge effect with
// the commit GitHub reports. A chain may not continue from an adoption whose code is still owed.
export const AdoptionCodeDebtSchema = z.object({
  repo: z.string().min(1), // "owner/name"
  prNumber: z.number().int(),
  sha: z.string().optional(), // the head the round measured, asserted at merge when known
  state: z.enum(["owed", "merged"]),
  mergedSha: z.string().optional(),
  mergedAt: z.string().optional(),
});
export type AdoptionCodeDebt = z.infer<typeof AdoptionCodeDebtSchema>;

export const AdoptionOperationSchema = z.object({
  operationId: z.string().min(1),
  tenant: z.string().min(1),
  proof: CampaignAdoptionProofSchema,
  state: AdoptionOperationStateSchema,
  // The merge the close owes when the candidate came from a pull request (D5). Absent = no code debt: the
  // candidate named no pull request, or the row predates this.
  code: AdoptionCodeDebtSchema.optional(),
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
  // ── WHOSE CAMPAIGN THIS IS (arch-review 76 P1-security) ─────────────────────────────────────────
  //
  // Frozen at open from the ISSUE's team — the campaign journals into it, so they cannot belong to
  // different teams without one of them being a lie. It is what the read surface filters on and what the
  // adopt mutation gates against: a campaign carrying no team of its own could only be gated by a
  // workspace-level action, which asks nothing about the resource being changed.
  //
  // OPTIONAL AT REST, because rows written before this existed have none. Absent means UNOWNED, which the
  // authz kernel lets through — never "everyone's" (rule `api-layer`). Not backfilled: guessing which team
  // an old campaign belonged to would invent an authority nobody granted.
  //
  // ── FROZEN, AND IT CAN DIVERGE FROM THE ISSUE'S (arch-review 114) ───────────────────────────────
  //
  // Taken from the issue's team at open and never refreshed. `POST /issues/:id/team` moves the issue and
  // nothing re-teams its campaigns, so after a move this names the team that OPENED the campaign, not the
  // team that now owns the issue. Migration 0198 says the two "cannot belong to different teams without one
  // of them being a lie"; that sentence predates nothing and is simply wrong, and the migration cannot be
  // edited (rule `db`), so the correction lives here — where a reader looks up what the field means.
  //
  // Divergence is SAFE by construction, and deliberately so: the adopt route gates on this frozen authority
  // AND on `teamOfEntity` — the live owner of the entity being written — either of which refuses. A move
  // therefore cannot widen what an adoption may do, which is the property that matters.
  //
  // What it does leave is a campaign the issue's new team can neither write to nor, when the old team is
  // private, see. That is the over-restrictive direction, and it is a consequence of freezing rather than a
  // defect — written down instead of denied.
  teamId: z.string().min(1).optional(),
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
