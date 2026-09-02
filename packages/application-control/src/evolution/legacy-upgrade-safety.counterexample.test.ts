import {
  AdoptionOperationSchema,
  type CampaignFrame,
  type CampaignRound,
  EvolutionCampaignRecordSchema,
} from "@everdict/contracts";
import { campaignAdoption } from "@everdict/domain";
import { describe, expect, it } from "vitest";

// ── A CREATION RULE APPLIED AT DECODE TIME IS A DATA OUTAGE — TWICE MORE (arch-review 75) ───────────
//
// arch-review 72 found this exact defect on the campaign FRAME and closed it by splitting creation from
// storage. The wave that closed it then tightened two NESTED shapes the same way and did not split either:
//
//     round.verdict.observations   gained REQUIRED `assessed` / `eligible`  (arch-review 72 P2)
//     proof.candidate              gained a REQUIRED `identity`             (arch-review 72 P1-medium)
//
// `PgEvolutionCampaignStore` parses whole stored rows through `EvolutionCampaignRecordSchema`, and `list()`
// is `rows.map(rowToRecord)` — so ONE legacy round takes down a workspace's entire campaign list.
// `PgAdoptionOperationStore` parses the stored proof the same way, so a legacy operation breaks the very
// adoption read arch-review 73 added to make `decided` visible.
//
// Measured before the split, observed:
//   rounds.0.verdict.observations.assessed  Required
//   proof.candidate.identity                Required
//
// The two repairs are deliberately different, and the difference is the point:
//
//   identity   DERIVED on read. `exact` MEANS the proof named bytes, so `specDigest !== undefined` is the
//              same predicate the minter applies — normalizing is not a guess, and it keeps the field
//              non-optional downstream so nobody can confuse a weak proof with a strong one again.
//   coverage   LEFT ABSENT. A number here cannot be derived from anything; inventing one would manufacture
//              exactly the evidence `minimumCoverage` exists to require. Absent is UNKNOWN, and the gate
//              refuses it whenever a frame demanded coverage.

const legacyFrame = {
  subject: { type: "agent", id: "a1", baselineVersion: "1.0.0" },
  scenarios: [
    { id: "h1", heldOut: true },
    { id: "h2", heldOut: true },
  ],
  judges: [],
  trialsPerCase: 3,
  budget: { maxRounds: 5 },
  stopAfterRejectedRounds: 3,
  significance: {},
  allowUnverifiedIdentity: false,
  allowLabelOnlyAdoption: false,
};

// …and the same frame written under the rules in force: the significance level and the held-out family are
// declarations now, so a frame that states neither is legacy by definition. Every fixture below that is meant
// to be CONFORMING derives from this one — a fixture defaulting to the weaker shape turns every test that
// does not care about statistics into a test of the weak branch (rule protocol, the fixture-drift law).
const conformingFrame = {
  ...legacyFrame,
  significance: { fdrAlpha: 0.05, heldOutFamilySize: 5 }, // family >= budget.maxRounds
  oracleScope: [], // …and every key a frame written today carries
};

// A round stored before coverage existed: the observations block has only the two failure counts.
const legacyRound = {
  seq: 1,
  hypothesis: "structure over phrasing",
  candidateVersion: "1.1.0",
  baselineScorecardId: "sc-b",
  candidateScorecardId: "sc-c",
  at: "2026-01-01T00:00:00.000Z",
  by: "alice",
  verdict: {
    comparable: true,
    significantImprovements: 1,
    significantRegressions: 0,
    heldOut: { improvements: 1, regressions: 0 },
    observations: { divergent: 0, unclear: 0 },
    unverifiedAxes: [],
    confoundedAxes: [],
  },
};

const legacyRow = {
  id: "camp-old",
  tenant: "acme",
  issueId: "iss-1",
  frame: legacyFrame,
  frameDigest: "sha256:x",
  rounds: [legacyRound],
  state: "open",
  createdBy: "alice",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

// An operation stored before `identity` existed.
const legacyOperation = (specDigest?: string) => ({
  operationId: "adopt/acme/camp-old",
  tenant: "acme",
  proof: {
    campaignId: "camp-old",
    frameDigest: "sha256:x",
    roundSeq: 1,
    candidate: { type: "agent", id: "a1", version: "1.1.0", ...(specDigest ? { specDigest } : {}) },
    provingScorecardId: "sc-c",
    issueId: "iss-1",
    gateDigest: "sha256:g",
  },
  state: "decided",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("[R75 COUNTEREXAMPLE] rows written before the rules still decode", () => {
  it("DECODES a campaign whose round predates observation coverage", () => {
    const parsed = EvolutionCampaignRecordSchema.safeParse(legacyRow);
    expect(parsed.success, "a round stored before coverage existed took down the campaign list").toBe(true);
    // …and it reads back as UNKNOWN coverage, not as zero. A backfilled number would be manufactured evidence.
    if (!parsed.success) return;
    const observations = parsed.data.rounds[0]?.verdict.observations;
    expect(observations?.divergent).toBe(0);
    expect(observations?.assessed, "coverage was invented for a round that never recorded any").toBeUndefined();
    expect(observations?.eligible).toBeUndefined();
  });

  it("DECODES an operation whose proof predates `identity`, and NORMALIZES its strength", () => {
    const exact = AdoptionOperationSchema.safeParse(legacyOperation("sha256:c1"));
    expect(exact.success, "an operation stored before `identity` existed became unreadable").toBe(true);
    // Derived, not guessed: naming bytes IS what `exact` means.
    expect(exact.success && exact.data.proof.candidate.identity).toBe("exact");

    const labelOnly = AdoptionOperationSchema.safeParse(legacyOperation());
    expect(labelOnly.success).toBe(true);
    expect(labelOnly.success && labelOnly.data.proof.candidate.identity).toBe("label_only");
  });

  it("does NOT let a stated identity be overwritten by the derivation", () => {
    // The normalization fills a gap; it never re-decides a proof that already said what it was. A campaign
    // that recorded `label_only` beside a digest (a deployment quirk, or a future arm) keeps its own word.
    const stated = legacyOperation("sha256:c1");
    (stated.proof.candidate as { identity?: string }).identity = "label_only";
    const parsed = AdoptionOperationSchema.safeParse(stated);
    expect(parsed.success && parsed.data.proof.candidate.identity).toBe("label_only");
  });
});

// ── AND A ROW THAT MAY BE READ MAY NOT PRODUCE NEW EVIDENCE (arch-review 75 P1-high) ───────────────
//
// The other half of the same split, and the half arch-review 72 did not think about. A campaign stored with
// ONE held-out scenario is still `open`. Nothing stopped it logging a fresh round after the upgrade — and
// that round carries a `heldOut` block built from the frame's single flag, which is precisely the evidence
// the two-scenario rule exists to require. The gate then asks only `improvements >= 1 && regressions === 0`
// and adopts.
//
// The legacy-decode test's sentence "a legacy campaign is not adoption evidence" was true only of rows
// written BEFORE the upgrade. Add one round after it and the campaign gets its authority back.
//
// Seen RED before the eligibility guard, observed:
//   legacy 1-held-out frame + new round → adopt ADOPTS v1.1.0
const oneHeldOut = {
  ...conformingFrame,
  scenarios: [
    { id: "only-one", heldOut: true },
    { id: "train", heldOut: false },
  ],
  observationPolicy: { allowDivergent: false },
} as unknown as CampaignFrame;

const roundAfterUpgrade = {
  ...legacyRound,
  verdict: { ...legacyRound.verdict, candidateSpecDigest: "sha256:c1", observations: undefined },
} as unknown as CampaignRound;

describe("[R75 COUNTEREXAMPLE] a frame that may be read may not decide", () => {
  it("still ADOPTS at the pure gate — which is why the refusal cannot live there", () => {
    // The gate is a total function over the frame and the rounds; it has no idea the frame is legacy, and
    // teaching it would make the pure decision depend on a schema version. The refusal belongs to the
    // SERVICE, at every entry point that produces or consumes new evidence.
    expect(campaignAdoption(oneHeldOut, [roundAfterUpgrade]).kind).toBe("adopt");
  });

  it("the frame's own defects are the ONE predicate, shared with the creation schema", async () => {
    // Written twice it would already have diverged (rule `protocol` L3). This is the value `logRound`,
    // `decision` and `settle` all consume, and it is the same one `CampaignFrameSchema` refuses on.
    const { campaignFrameDefects } = await import("@everdict/contracts");
    expect(campaignFrameDefects(oneHeldOut)).toHaveLength(1);
    expect(campaignFrameDefects(oneHeldOut)[0]).toMatch(/at least 2 held-out/);
    expect(
      campaignFrameDefects({
        ...conformingFrame,
        scenarios: [
          { id: "d", heldOut: true },
          { id: "d", heldOut: true },
        ],
      }),
    ).toEqual(["scenario ids must be unique — the gate compares the two sides by id set"]);
    expect(campaignFrameDefects(conformingFrame as unknown as CampaignFrame), "a conforming frame was refused").toEqual(
      [],
    );
  });

  // ── …AND THE SAME LAW APPLIED TO THE STATISTICS THE NEXT WAVE FROZE ──────────────────────────────
  //
  // `heldOutFamilySize` is the same shape as the two-held-out rule one level down: a frame that never
  // declared it is READABLE (the row above still decodes) and may not produce NEW adoption evidence, because
  // its rounds would be judged at a level nobody pre-registered. Asserted here rather than in the new
  // counterexample so the legacy split stays one file: this is what "may be read, may not decide" now means.
  it("a frame that pre-dates the pre-registered family is readable and may not decide", async () => {
    const { campaignFrameDefects } = await import("@everdict/contracts");
    const defects = campaignFrameDefects(legacyFrame as unknown as CampaignFrame);
    expect(defects).toHaveLength(2);
    expect(defects.join("; ")).toMatch(/significance\.fdrAlpha must be declared/);
    expect(defects.join("; ")).toMatch(/significance\.heldOutFamilySize must be declared/);
    // …and the row itself still parses, which is the whole point of the split.
    expect(EvolutionCampaignRecordSchema.safeParse(legacyRow).success).toBe(true);
  });

  // A family SMALLER than the budget corrects for fewer tests than the campaign may run — the arithmetic
  // equivalent of not correcting at all, and the easiest way to appear to have done it.
  it("refuses a family smaller than the rounds it is allowed to spend", async () => {
    const { campaignFrameDefects } = await import("@everdict/contracts");
    const understated = { ...conformingFrame, significance: { fdrAlpha: 0.05, heldOutFamilySize: 2 } };
    const defects = campaignFrameDefects(understated as unknown as CampaignFrame);
    expect(defects).toHaveLength(1);
    expect(defects[0]).toMatch(/below budget\.maxRounds \(5\)/);
  });
});
