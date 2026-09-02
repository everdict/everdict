import type { CampaignFrameFromIssue } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { caseLinksOf, frameFromCases } from "./frame-from-issue.js";

// ── THE EXAM IS THE ISSUE'S (docs/architecture/evolution-routing-spec.md §3) ─────────────────────────
const base: CampaignFrameFromIssue = {
  fromIssue: true,
  subject: { type: "harness", id: "shop", baselineVersion: "1.0.0" },
  judges: [],
  trialsPerCase: 5,
  budget: { maxRounds: 4 },
  stopAfterRejectedRounds: 3,
  significance: { fdrAlpha: 0.05, heldOutFamilySize: 4 },
  allowUnverifiedIdentity: false,
  allowLabelOnlyAdoption: false,
  oracleScope: [],
  observationPolicy: { allowDivergent: false },
};
const link = (id: string, over: Record<string, unknown> = {}) => ({
  type: "case",
  id,
  dataset: "tb",
  version: "3",
  ...over,
});

describe("caseLinksOf — which exam the issue names", () => {
  it("one dataset version, its case ids, de-duplicated", () => {
    expect(caseLinksOf([link("c1"), link("c2"), link("c1"), { type: "harness", id: "shop" }])).toEqual({
      kind: "one",
      dataset: "tb",
      version: "3",
      caseIds: ["c1", "c2"],
    });
  });
  it("names every way the links fail to be one exam", () => {
    expect(caseLinksOf([{ type: "harness", id: "shop" }])).toEqual({ kind: "none" });
    expect(caseLinksOf([link("c1"), link("c2", { dataset: "other" })])).toEqual({
      kind: "several",
      datasets: ["tb", "other"],
    });
    expect(caseLinksOf([link("c1"), link("c2", { version: undefined })])).toEqual({ kind: "unpinned", dataset: "tb" });
    expect(caseLinksOf([link("c1"), link("c2", { version: "4" })])).toEqual({
      kind: "mixed_versions",
      dataset: "tb",
      versions: ["3", "4"],
    });
  });
});

describe("frameFromCases — targets are the linked cases, everything else is held-out", () => {
  it("derives scenarios and targets, and the result meets the creation rules", () => {
    const answer = frameFromCases(base, ["c1", "c2", "c3", "c4"], ["c1"]);
    expect(answer.kind).toBe("frame");
    if (answer.kind === "frame") {
      expect(answer.frame.targets).toEqual(["c1"]);
      expect(answer.frame.scenarios).toEqual([
        { id: "c1", heldOut: false },
        { id: "c2", heldOut: true },
        { id: "c3", heldOut: true },
        { id: "c4", heldOut: true },
      ]);
      expect("fromIssue" in answer.frame).toBe(false);
    }
  });
  it("refuses a case the dataset version does not hold, and an exam with too few held-out cases", () => {
    expect(frameFromCases(base, ["c1", "c2", "c3"], ["c9"])).toMatchObject({
      kind: "refused",
      reason: expect.stringMatching(/does not hold: c9/),
    });
    expect(frameFromCases(base, ["c1", "c2"], ["c1"])).toMatchObject({
      kind: "refused",
      reason: expect.stringMatching(/at least 2 held-out/),
    });
  });
});
