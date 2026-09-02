import { describe, expect, it } from "vitest";
import { CampaignFrameSchema, StoredCampaignFrameSchema, campaignFrameDefects } from "./evolution-campaign.js";

// ── TARGETS ARE SCENARIOS, NAMED ONCE, NEVER HELD-OUT (docs/architecture/evolution-routing-spec.md §3) ──
//
// A target is a case the loop is briefed on and optimizes against; the held-out block is the population that
// says whether the change generalized. One case in both would be counted as both, so the creation rule refuses
// it — at the door a NEW frame enters, never at decode (a stored frame keeps reading).
const base = {
  subject: { type: "harness" as const, id: "shop", baselineVersion: "1.0.0" },
  scenarios: [
    { id: "t1", heldOut: false },
    { id: "h1", heldOut: true },
    { id: "h2", heldOut: true },
  ],
  trialsPerCase: 5,
  budget: { maxRounds: 4 },
  significance: { fdrAlpha: 0.05, heldOutFamilySize: 4 },
};

describe("frame.targets — creation defects", () => {
  it("a target that is a non-held-out scenario is accepted, and the default is the empty list", () => {
    expect(CampaignFrameSchema.parse({ ...base, targets: ["t1"] }).targets).toEqual(["t1"]);
    expect(CampaignFrameSchema.parse(base).targets).toEqual([]);
  });
  it("refuses a target that is not a scenario, a held-out target, and a duplicate target — each by name", () => {
    expect(campaignFrameDefects({ ...base, targets: ["nope"] }).join("\n")).toMatch(/not in scenarios: nope/);
    expect(campaignFrameDefects({ ...base, targets: ["h1"] }).join("\n")).toMatch(/cannot also be held-out: h1/);
    expect(campaignFrameDefects({ ...base, targets: ["t1", "t1"] }).join("\n")).toMatch(/target ids must be unique/);
    expect(CampaignFrameSchema.safeParse({ ...base, targets: ["h1"] }).success).toBe(false);
  });
  it("a stored frame written before the field existed still decodes, with no targets", () => {
    expect(StoredCampaignFrameSchema.parse(base).targets).toEqual([]);
  });
});
