import type { CampaignFrame, CampaignRound } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { adoptionProofOf, campaignAdoption } from "./campaign-gate.js";

// ── A FIX THAT CLOSED THE LOUDER HALF AND REOPENED THE QUIET ONE (arch-review 73 P0) ────────────────
//
// arch-review 71 abolished exactly one state: a campaign that closes `adopted` while nothing anywhere is
// authorized to register the version it adopted. arch-review 72 then made a label-only adoption say so —
// and put the refusal in the PROOF MINTER rather than in the gate:
//
//     campaignAdoption(...)   → adopt{version: "1.0.1"}       ← the gate still says yes
//     adoptionProofOf(...)    → undefined                     ← nothing to authorize
//     settle(...)             → state = "adopted", adoption = undefined
//
// So the wave that was closing "a weak adoption reads like a strong one" reopened "adopted and nothing
// adopted anything" — at the same seam, one commit later, and the existing route suite stayed green over it
// because its fixture asserts the close and never asks what the close authorized.
//
// Two things were wrong, and only one of them is the policy:
//
//   · the DECISION belongs to the decision function. `allowLabelOnlyAdoption` is a frozen frame
//     declaration, and rule `suite` already says a declaration is not part of the constitution until the
//     function that decides also consumes it. `adoptionProofOf` mints; it does not adjudicate.
//   · `adopt` + no proof must be UNREPRESENTABLE, not merely unreached. A gate that refuses is a gate that
//     some later change can stop refusing; the settle's own guard is what makes the state impossible.
//
// The refusal is `identity_unverified` on purpose: the campaign stays OPEN, because the fix is another
// round through a lane that seals a manifest — the same reasoning that answer already carries for an
// unverifiable world axis. A campaign that cannot name the bytes it measured has not proved a candidate; it
// has proved a name, and neither ending fits that.
//
// Seen RED before the gate consumed the declaration, observed:
//   the gate adopted a candidate whose bytes it could not name: expected 'adopt' to be 'halt'
//   …and: settle would close 'adopted' with NO authorization: true

const frameWith = (over: Partial<CampaignFrame> = {}): CampaignFrame =>
  ({
    subject: { type: "agent", id: "everdict", baselineVersion: "1.0.0" },
    scenarios: [
      { id: "c1", heldOut: true },
      { id: "c2", heldOut: true },
    ],
    judges: [],
    trialsPerCase: 5,
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

// A round that WON on the held-out population — and whose scorecard sealed no manifest, so nothing can say
// which bytes were measured. This is the ordinary shape of an ingested/pull-mode batch, not an exotic one.
const wonWithoutBytes = (specDigest?: string): CampaignRound =>
  ({
    seq: 1,
    hypothesis: "structure over phrasing",
    candidateVersion: "1.0.1",
    baselineScorecardId: "sc-b",
    candidateScorecardId: "sc-c",
    at: "2026-08-27T00:00:00.000Z",
    by: "alice",
    verdict: {
      comparable: true,
      significantImprovements: 1,
      significantRegressions: 0,
      heldOut: { improvements: 1, regressions: 0 },
      unverifiedAxes: [],
      confoundedAxes: [],
      ...(specDigest !== undefined ? { candidateSpecDigest: specDigest } : {}),
    },
  }) as unknown as CampaignRound;

const campaignOf = (frame: CampaignFrame) => ({ id: "camp-1", frameDigest: "sha256:frame", issueId: "iss-9", frame });

describe("[R73 COUNTEREXAMPLE] an adopt answer always carries something to authorize", () => {
  it("REFUSES to adopt a candidate whose bytes the campaign cannot name", () => {
    const frame = frameWith();
    const rounds = [wonWithoutBytes()];

    const answer = campaignAdoption(frame, rounds);

    expect(answer.kind, "the gate adopted a candidate whose bytes it could not name").toBe("halt");
    if (answer.kind !== "halt") return;
    // The campaign stays OPEN — the remedy is another round, not an ending. Recording `no_improvement` over
    // a candidate that improved would be the gate lying about why it stopped.
    expect(answer.reason).toBe("identity_unverified");
    expect(answer.detail).toMatch(/bytes|spec digest/i);
  });

  it("and there is therefore no adopt answer that mints no proof", () => {
    // The property the settle rests on, stated over BOTH frames: whenever the gate says adopt, a proof
    // exists. An `adopt` with no proof is the state arch-review 71 abolished, and this is what keeps it
    // abolished as the minting rules change.
    for (const frame of [frameWith(), frameWith({ allowLabelOnlyAdoption: true } as Partial<CampaignFrame>)])
      for (const rounds of [[wonWithoutBytes()], [wonWithoutBytes("sha256:c1")]]) {
        const answer = campaignAdoption(frame, rounds);
        if (answer.kind !== "adopt") continue;
        expect(
          adoptionProofOf(answer, campaignOf(frame), rounds),
          "the gate adopted and authorized nothing — settle would close 'adopted' with no operation",
        ).toBeDefined();
      }
  });

  it("ADOPTS when the frame waived it, and the proof says the adoption is label-only", () => {
    // The waiver still works, and it is still visible as the weaker thing — the arch-review 72 property,
    // unchanged by moving the decision.
    const frame = frameWith({ allowLabelOnlyAdoption: true } as Partial<CampaignFrame>);
    const rounds = [wonWithoutBytes()];

    const answer = campaignAdoption(frame, rounds);
    expect(answer.kind).toBe("adopt");
    const proof = adoptionProofOf(answer, campaignOf(frame), rounds);
    expect(proof?.candidate.identity).toBe("label_only");
    expect(proof?.candidate.specDigest).toBeUndefined();
  });

  it("ADOPTS on exact bytes without any waiver", () => {
    // The control. A gate that refused everything would be a campaign that can never adopt.
    const frame = frameWith();
    const rounds = [wonWithoutBytes("sha256:c1")];

    const answer = campaignAdoption(frame, rounds);
    expect(answer.kind).toBe("adopt");
    const proof = adoptionProofOf(answer, campaignOf(frame), rounds);
    expect(proof?.candidate.identity).toBe("exact");
    expect(proof?.candidate.specDigest).toBe("sha256:c1");
  });
});
