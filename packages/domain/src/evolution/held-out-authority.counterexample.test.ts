import type { CampaignFrame, CampaignRound } from "@everdict/contracts";
import { CampaignFrameSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { adoptionProofOf, campaignAdoption } from "./campaign-gate.js";

// ── HELD-OUT WAS AN ANNOTATION NOBODY READ (arch-review 71 P1-high) ─────────────────────────────────
//
// `CampaignFrame.scenarios[].heldOut` exists and its comment describes a discipline. Neither half of the
// system enforced it:
//
//     schema   scenarios.min(1) · heldOut defaults false · no superRefine at all
//     gate     zero references to `heldOut`; adoption wins on the WHOLE round
//
// So a campaign whose every scenario is training data adopts as soon as it improves on one of them with no
// regressions — the loop grading the homework it has been optimising against, which is the single thing a
// held-out set exists to prevent. Duplicate scenario ids were legal too, which quietly makes "the scenario
// set is the same on both sides" a weaker claim than it reads as.
//
//     held-out annotation exists   ≠   held-out evidence controls adoption
//
// Seen RED before the split, observed:
//   a campaign with no held-out evidence was accepted: expected [Function] to throw
//   training-only improvement was adopted: expected 'adopt' to be 'continue'

const frame = (over: Partial<CampaignFrame> = {}): CampaignFrame =>
  ({
    subject: { type: "agent", id: "a1", baselineVersion: "1.0.0" },
    scenarios: [
      { id: "held-1", heldOut: true },
      { id: "held-2", heldOut: true },
    ],
    judges: [],
    trialsPerCase: 3,
    budget: { maxRounds: 5 },
    stopAfterRejectedRounds: 3,
    significance: { fdrAlpha: 0.05, heldOutFamilySize: 5 }, // frozen: the level, and the family it is corrected over
    allowUnverifiedIdentity: false,
    allowLabelOnlyAdoption: false,
    oracleScope: [],
    targets: [],
    observationPolicy: { allowDivergent: false },
    ...over,
  }) as unknown as CampaignFrame;

// A round whose verdict separates the two populations, which is what the gate has to be handed before it can
// tell "improved where it was trained" from "improved where it was not".
const round = (over: {
  heldOutImprovements?: number;
  heldOutRegressions?: number;
  trainingImprovements?: number;
  trainingRegressions?: number;
  divergent?: number;
  unclear?: number;
  // A real round's candidate scorecard seals a manifest, so a digest is the DEFAULT here — leaving it out
  // put every case in this file on the label-only path, which is not the axis any of them is about
  // (arch-review 73). Only the case that IS about naming bytes opts out.
  noBytes?: boolean;
}): CampaignRound =>
  ({
    seq: 1,
    hypothesis: "the candidate is better",
    candidateVersion: "1.1.0",
    baselineScorecardId: "sc-base",
    candidateScorecardId: "sc-cand",
    verdict: {
      comparable: true,
      significantImprovements: (over.heldOutImprovements ?? 0) + (over.trainingImprovements ?? 0),
      significantRegressions: (over.heldOutRegressions ?? 0) + (over.trainingRegressions ?? 0),
      heldOut: {
        improvements: over.heldOutImprovements ?? 0,
        regressions: over.heldOutRegressions ?? 0,
      },
      observations: { divergent: over.divergent ?? 0, unclear: over.unclear ?? 0 },
      ...(over.noBytes === true ? {} : { candidateSpecDigest: "sha256:cand" }),
      unverifiedAxes: [],
      confoundedAxes: [],
    },
  }) as unknown as CampaignRound;

describe("[R71 COUNTEREXAMPLE] the schema refuses a campaign that cannot prove anything", () => {
  it("REFUSES a frame with no held-out scenarios", () => {
    expect(
      () => CampaignFrameSchema.parse(frame({ scenarios: [{ id: "training-1", heldOut: false }] } as never)),
      "a campaign with no held-out evidence was accepted",
    ).toThrow();
  });

  it("REFUSES a frame with only one held-out scenario", () => {
    // One is a coin flip dressed as evidence: a single case that moved is exactly what a loop optimising
    // against a small set produces by chance.
    expect(() =>
      CampaignFrameSchema.parse(frame({ scenarios: [{ id: "h", heldOut: true }, { id: "t" }] } as never)),
    ).toThrow();
  });

  it("REFUSES duplicate scenario ids", () => {
    // The gate compares scenario-ID SETS across the two sides. Duplicates make that comparison weaker than
    // it reads as, and they make "how many held-out scenarios are there" unanswerable.
    expect(() =>
      CampaignFrameSchema.parse(
        frame({
          scenarios: [
            { id: "same", heldOut: true },
            { id: "same", heldOut: true },
          ],
        } as never),
      ),
    ).toThrow();
  });

  it("accepts the frame a real campaign declares", () => {
    expect(() => CampaignFrameSchema.parse(frame())).not.toThrow();
  });
});

describe("[R71 COUNTEREXAMPLE] adoption authority comes from the held-out population only", () => {
  it("does NOT adopt on training-only improvement", async () => {
    // The defect, stated as the experiment it is: the candidate improved exactly where the loop has been
    // pushing, and nowhere it was not allowed to look.
    const answer = campaignAdoption(frame(), [round({ trainingImprovements: 3, heldOutImprovements: 0 })]);
    expect(answer.kind, "training-only improvement was adopted").toBe("continue");
  });

  it("adopts when the HELD-OUT population improved and did not regress", async () => {
    const answer = campaignAdoption(frame(), [round({ heldOutImprovements: 1 })]);
    expect(answer.kind, "held-out improvement did not carry adoption authority").toBe("adopt");
  });

  it("REFUSES adoption on any held-out regression, however much training improved", async () => {
    const answer = campaignAdoption(frame(), [
      round({ heldOutImprovements: 2, heldOutRegressions: 1, trainingImprovements: 9 }),
    ]);
    expect(answer.kind, "a held-out regression was outvoted by training gains").not.toBe("adopt");
  });
});

// ── A TYPED FACT THAT COULD NOT REACH THE DECISION (arch-review 71 P1-evolution) ────────────────────
//
// A judge shown the platform's own observation account answers whether the trace's claims and that account
// agree. `divergent` is the judge saying the candidate's story does not match what the platform watched it
// do — the strongest negative evidence this system can produce.
//
// It was born TYPED from the model and folded into `Score.detail` as prose:
//
//     [observations: divergent — the trace claims a retry the samples never show]
//
// and `judge.ts` said so in its own comment: "a gate that wants to weigh it needs the field on the
// contract." The campaign round read trial delta, significance, regressions and identity — never this. So a
// candidate could improve its numbers while its own judges said it was not telling the truth about how, and
// adopt on the improvement.
//
// Seen RED before the field reached the gate, observed:
//   a candidate whose own judge called its account divergent was adopted: expected 'adopt' to be 'continue'

describe("[R71 COUNTEREXAMPLE] a divergent observation account refuses adoption", () => {
  it("does NOT adopt when the candidate's own judges called its account divergent", () => {
    const answer = campaignAdoption(frame(), [round({ heldOutImprovements: 3, divergent: 1 })]);
    expect(answer.kind, "a candidate whose own judge called its account divergent was adopted").toBe("continue");
  });

  it("adopts under a frame that RECORDED the waiver at open", () => {
    // The escape hatch is a frozen decision, not a runtime argument: a campaign optimizing through known
    // observation noise says so in the frame, before it sees any rounds.
    const permissive = frame({ observationPolicy: { allowDivergent: true } } as never);
    expect(campaignAdoption(permissive, [round({ heldOutImprovements: 1, divergent: 2 })]).kind).toBe("adopt");
  });

  it("REFUSES when unclear exceeds the frame's bound", () => {
    // `unclear` is neither arm. A round mostly made of "I could not tell" is not evidence, and a campaign
    // that cares says how much it will accept.
    const bounded = frame({ observationPolicy: { allowDivergent: false, maxUnclear: 1 } } as never);
    expect(campaignAdoption(bounded, [round({ heldOutImprovements: 2, unclear: 5 })]).kind).toBe("continue");
    expect(campaignAdoption(bounded, [round({ heldOutImprovements: 2, unclear: 1 })]).kind).toBe("adopt");
  });

  it("adopts normally when the account holds up", () => {
    expect(campaignAdoption(frame(), [round({ heldOutImprovements: 1 })]).kind).toBe("adopt");
  });
});

// ── AN ADOPTED LABEL IS NOT ADOPTED BYTES (arch-review 71 P0-evolution) ─────────────────────────────
//
// The round named a candidate VERSION and the close named the same version. A version is a LABEL: candidate
// C1 is evaluated, C2 is saved under the same `id@version`, and nothing in the campaign can tell them apart
// — so "this version was proved" is a claim about a string rather than about bytes.
//
// The scorecard already seals the digest of the spec its batch ran (`manifest.harness.specDigest`), so the
// join was in hand and dropped at the write. It is recorded on the round that proved it and carried into the
// gate's answer, which is what any later adoption effect has to check what it is about to register against.
//
// ⚠️ THIS IS THE JOIN, NOT THE WHOLE PROTOCOL. Campaign adoption still executes no registry effect — the
// close is a decision record and the caller is still told to save separately. What this closes is the part
// every later proof would have rested on: without the digest, no proof-carrying adoption could be trusted
// even once it exists.
//
// Seen RED before the digest travelled, observed:
//   the adoption named a version but not the bytes it proved: expected undefined to be 'sha256:c1'

describe("[R71 COUNTEREXAMPLE] an adoption names the bytes it proved", () => {
  it("carries the proving round's candidate spec digest into the answer", () => {
    const proved = round({ heldOutImprovements: 1, noBytes: true });
    (proved.verdict as { candidateSpecDigest?: string }).candidateSpecDigest = "sha256:c1";

    const answer = campaignAdoption(frame(), [proved]);

    expect(answer.kind).toBe("adopt");
    expect(
      answer.kind === "adopt" ? answer.candidateSpecDigest : undefined,
      "the adoption named a version but not the bytes it proved",
    ).toBe("sha256:c1");
  });

  it("says plainly when the round could not name them — under the frame that allowed it", () => {
    // A built-in harness has no declarative spec to digest, and older rows have none. Absent is an honest
    // weaker adoption an operator can see — not one that reads the same as a strong one.
    //
    // The FRAME now has to have said so (arch-review 73): the gate refuses an adoption it cannot name
    // bytes for, because a close carrying no authorization is the state arch-review 71 abolished. What
    // this case pins is unchanged — the answer says `undefined` rather than inventing a digest.
    const waiving = frame({ allowLabelOnlyAdoption: true } as never);
    const answer = campaignAdoption(waiving, [round({ heldOutImprovements: 1, noBytes: true })]);
    expect(answer.kind).toBe("adopt");
    expect(answer.kind === "adopt" ? answer.candidateSpecDigest : "x").toBeUndefined();
  });
});

// ── A WEAK PROOF THAT READS LIKE A STRONG ONE (arch-review 72 P1-medium / P2) ───────────────────────
//
// `specDigest` was optional, so an adoption naming EXACT BYTES and one naming only a version LABEL were the
// same value to every reader: same `adopted` state, same `decided` operation, nothing to tell them apart.
// And observation coverage counted only failures, so "every judge said consistent" and "no judge recorded
// anything" both read `divergent: 0, unclear: 0`.
//
// Both are the same defect in the EVIDENCE rather than in the wiring: an absence rendered as a clean bill of
// health. Strength is a field now, a label-only adoption needs a waiver the frame recorded before it saw any
// round, and a campaign that wants the independent account to mean something declares how much of it it needs.
//
// Seen RED before the split, observed:
//   a campaign that could not name the bytes adopted anyway: expected 'adopt' to be undefined
//   zero divergences over zero assessments read as a clean account: expected 'adopt' to be 'continue'

describe("[R72 COUNTEREXAMPLE] a proof says how strong it is", () => {
  // `digest` absent means THIS ROUND COULD NOT NAME ITS BYTES — the digest is stripped rather than merely
  // not added, so the helper says what it means whatever the round builder defaults to (arch-review 73: the
  // builder now seals one, and a helper that only ever added would have quietly stopped testing the case).
  const proofFor = (f: CampaignFrame, r: CampaignRound[], digest?: string) => {
    const withDigest = r.map((x) => {
      const { candidateSpecDigest: _dropped, ...verdict } = x.verdict as CampaignRound["verdict"] & {
        candidateSpecDigest?: string;
      };
      return {
        ...x,
        verdict: { ...verdict, ...(digest !== undefined ? { candidateSpecDigest: digest } : {}) },
      } as unknown as CampaignRound;
    });
    const campaign = { id: "camp-1", frameDigest: "sha256:f", issueId: "iss-1", frame: f };
    return {
      answer: campaignAdoption(f, withDigest),
      proof: adoptionProofOf(campaignAdoption(f, withDigest), campaign, withDigest),
    };
  };

  it("mints an EXACT proof when the campaign could name the bytes", () => {
    const { proof } = proofFor(frame(), [round({ heldOutImprovements: 1 })], "sha256:c1");
    expect(proof?.candidate.identity).toBe("exact");
    expect(proof?.candidate.specDigest).toBe("sha256:c1");
  });

  it("ADOPTS NOTHING when it cannot name them and the frame never allowed it", () => {
    // ⚠️ RE-AIMED (arch-review 73). The refusal used to live at the proof minter, and a minter that refuses
    // while the GATE still answers `adopt` is a close carrying no authorization — arch-review 71's abolished
    // state, reopened by the change that introduced this very case. The invariant is unchanged; its enforcer
    // moved to the function that decides, which is where the frame's declaration is consumed.
    const { answer, proof } = proofFor(frame(), [round({ heldOutImprovements: 1 })]);
    expect(answer.kind, "a campaign that could not name the bytes adopted anyway").toBe("halt");
    expect(proof, "an adopt-less answer still minted an authorization").toBeUndefined();
  });

  it("mints a LABEL_ONLY proof under the frame's recorded waiver, and says so", () => {
    // Allowed, and visible. The point is not to forbid it — some candidates genuinely have no declarative
    // spec — but to stop it reading identically to an adoption that proved bytes.
    const permissive = frame({ allowLabelOnlyAdoption: true } as never);
    const { proof } = proofFor(permissive, [round({ heldOutImprovements: 1 })]);
    expect(proof?.candidate.identity).toBe("label_only");
    expect(proof?.candidate.specDigest).toBeUndefined();
  });
});

describe("[R72 COUNTEREXAMPLE] missing observations are not a clean account", () => {
  const covered = (assessed: number, eligible: number): CampaignRound =>
    ({
      ...round({ heldOutImprovements: 1 }),
      verdict: {
        ...round({ heldOutImprovements: 1 }).verdict,
        observations: { divergent: 0, unclear: 0, assessed, eligible },
      },
    }) as unknown as CampaignRound;

  it("REFUSES a round nobody looked at, under a frame that requires coverage", () => {
    const strict = frame({ observationPolicy: { allowDivergent: false, minimumCoverage: 0.5 } } as never);
    expect(
      campaignAdoption(strict, [covered(0, 10)]).kind,
      "zero divergences over zero assessments read as a clean account",
    ).toBe("continue");
  });

  it("ADOPTS when enough of the round was actually assessed", () => {
    const strict = frame({ observationPolicy: { allowDivergent: false, minimumCoverage: 0.5 } } as never);
    expect(campaignAdoption(strict, [covered(8, 10)]).kind).toBe("adopt");
  });

  it("REFUSES a round with NO observations block at all, under a frame that requires coverage", () => {
    // ⚠️ The case the first version did not have, and the reason it passed over its own defect: the
    // coverage check was nested under `if (obs !== undefined)`, so the round that recorded NOTHING — the
    // loudest silence there is — skipped the requirement entirely (arch-review 75 P1-medium).
    //
    // Seen RED before the policy-first entry, observed:
    //   minimumCoverage 0.5 + NO observations block → adopt (bypassed)
    const strict = frame({ observationPolicy: { allowDivergent: false, minimumCoverage: 0.5 } } as never);
    // Built WITHOUT the block rather than deleting it: a round that never recorded observations is a
    // different document, not one with a field removed.
    const { observations: _none, ...bareVerdict } = round({ heldOutImprovements: 1 }).verdict;
    const bare = { ...round({ heldOutImprovements: 1 }), verdict: bareVerdict } as unknown as CampaignRound;

    expect(
      campaignAdoption(strict, [bare]).kind,
      "a frame demanding coverage was satisfied by a round that recorded none",
    ).toBe("continue");
  });

  it("REFUSES a round whose coverage block predates assessed/eligible", () => {
    // The legacy shape (arch-review 75 P1-high): decodable, and NOT clean. Absent coverage is unknown, and
    // a campaign that demanded a level may not be answered with an unknown.
    const strict = frame({ observationPolicy: { allowDivergent: false, minimumCoverage: 0.5 } } as never);
    const legacy = round({ heldOutImprovements: 1 });
    (legacy.verdict as { observations?: unknown }).observations = { divergent: 0, unclear: 0 };

    expect(campaignAdoption(strict, [legacy]).kind).toBe("continue");
  });

  it("leaves a frame that asked for no coverage exactly as it was", () => {
    // The control: coverage is opt-in, and a campaign that never declared a requirement keeps the behaviour
    // it had. This adds a way to demand evidence; it does not silently start refusing.
    expect(campaignAdoption(frame(), [covered(0, 10)]).kind).toBe("adopt");
  });
});
