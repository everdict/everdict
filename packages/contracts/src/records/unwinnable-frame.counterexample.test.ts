import { describe, expect, it } from "vitest";
import { CampaignFrameSchema, StoredCampaignFrameSchema, unwinnableFrameDefect } from "./evolution-campaign.js";

// ── AN EXAM NO OUTCOME CAN PASS IS NOT AN EXAM (found by running the loop, evolution wave of 2026-09-04) ──
//
// A round's significance is Fisher exact (both arms under FISHER_MAX_N trials) judged by Benjamini-Hochberg at
// `fdrAlpha / heldOutFamilySize`. Fisher over two arms of n has a FLOOR: the most extreme table two equal arms
// can produce is perfect separation, p = 2/C(2n,n), and no candidate however good can go below it. So when
// that floor exceeds the corrected level, EVERY round of the campaign records zero significant cases — for
// arithmetic reasons, before any agent runs.
//
// This is not hypothetical and it is not exotic. At the ordinary `fdrAlpha: 0.05`, every frame declaring four
// trials or fewer is in this state:
//
//     n=3  floor 0.100000      familySize  3 → alpha' 0.01667   dead at n ≤ 4
//     n=4  floor 0.028571      familySize  5 → alpha' 0.01000   dead at n ≤ 4
//     n=5  floor 0.007937      familySize 10 → alpha' 0.00500   dead at n ≤ 5
//
// What made it worth a refusal is how it FAILS: not an error, but a campaign that opens, spends its whole
// round budget on real agent runs, and halts `no_improvement` — indistinguishable from a subject that genuinely
// did not improve. The driver reads "nothing worked" and the truth is "nothing could have".
//
// The rule is CREATION-ONLY, and that is a decision rather than an omission: `trialsPerCase` is a floor, so a
// campaign declaring 3 and running 20 trials is legal and produces real significance. A decision-path refusal
// reading the declared number would have broken it — see `unwinnableFrameDefect`'s own comment.
//
// Observed RED before the fix, and the message is the invariant:
//   AssertionError: expected '' to match /no round of this campaign can produce a significant case/
//     — campaignFrameDefects accepted trialsPerCase 3 at alpha' 0.0167, whose Fisher floor is 0.1
const base = {
  subject: { type: "harness" as const, id: "shop", baselineVersion: "1.0.0" },
  scenarios: [
    { id: "t1", heldOut: false },
    { id: "h1", heldOut: true },
    { id: "h2", heldOut: true },
  ],
  budget: { maxRounds: 3 },
  significance: { fdrAlpha: 0.05, heldOutFamilySize: 3 },
};

describe("campaignFrameDefects — a frame whose declared floor makes significance unreachable", () => {
  it("refuses three trials at alpha' 0.0167, naming the floor and the level it cannot reach", () => {
    const defect = unwinnableFrameDefect({ ...base, trialsPerCase: 3 }) ?? "";
    expect(defect).toMatch(/no round of this campaign can produce a significant case/);
    // The repair has to be actionable, so the message carries both numbers the driver must move.
    expect(defect).toMatch(/0\.1/); // the floor at n=3
    expect(defect).toMatch(/0\.0166/); // fdrAlpha / heldOutFamilySize
    const parsed = CampaignFrameSchema.safeParse({ ...base, trialsPerCase: 3 });
    expect(parsed.success).toBe(false);
    // …and it is reported against the field the driver has to change, not buried under `scenarios`.
    if (!parsed.success) expect(parsed.error.issues.some((i) => i.path.includes("trialsPerCase"))).toBe(true);
  });

  it("accepts the same frame once the trials can reach the level — the repair the message asks for", () => {
    expect(unwinnableFrameDefect({ ...base, trialsPerCase: 5 })).toBeUndefined();
    expect(CampaignFrameSchema.safeParse({ ...base, trialsPerCase: 5 }).success).toBe(true);
  });

  it("is a boundary on the FLOOR, not a preference for large n: 4 is refused and 5 is not", () => {
    // 2/C(8,4) = 0.02857 > 0.01667 ≥ 2/C(10,5) = 0.00794. The frame is judged by what it CAN produce.
    expect(unwinnableFrameDefect({ ...base, trialsPerCase: 4 })).toMatch(/significant case/);
    expect(unwinnableFrameDefect({ ...base, trialsPerCase: 5 })).toBeUndefined();
  });

  it("reaches BOTH creation lanes, because a frame derived from an issue is parsed by the same schema", () => {
    // `frameFromIssue` (@everdict/domain) ends in `CampaignFrameSchema.safeParse(candidate)`, so a derived
    // frame carrying a dead floor is refused there too. Asserted through the schema the derivation calls,
    // since that is the seam both lanes share.
    expect(CampaignFrameSchema.safeParse({ ...base, trialsPerCase: 4 }).success).toBe(false);
  });

  it("a stored frame in this state still DECODES — the rule is on creation, not on rows already written", () => {
    // Same expand/contract discipline the held-out rule follows: a policy change is not an availability
    // regression. The gate stays fail-closed on its own, because such a round records nothing significant.
    expect(StoredCampaignFrameSchema.safeParse({ ...base, trialsPerCase: 3 }).success).toBe(true);
  });

  it("says nothing when the frame declares no level — that absence has its own defect", () => {
    // `campaignFrameDefects` already refuses an undeclared fdrAlpha; a second message about a level that does
    // not exist would name a number nobody chose.
    expect(
      unwinnableFrameDefect({ ...base, trialsPerCase: 3, significance: { heldOutFamilySize: 3 } }),
    ).toBeUndefined();
    expect(CampaignFrameSchema.safeParse({ ...base, trialsPerCase: 3, significance: {} }).success).toBe(false);
  });

  it("does not fire in the z-test regime, where the Fisher floor is not what decides", () => {
    // `FISHER_MAX_TRIALS` is 30, and `diffTrials` picks Fisher while EITHER arm is under it. `trialsPerCase`
    // is a floor, so declaring 30 means both arms run at least 30 and the diff takes the two-proportion z —
    // the exact test's floor stops being what binds, and this rule has nothing to say.
    expect(unwinnableFrameDefect({ ...base, trialsPerCase: 30 })).toBeUndefined();
  });
});
