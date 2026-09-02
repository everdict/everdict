import { describe, expect, it } from "vitest";
import { roundEvidenceKey, roundEvidenceOf } from "./round-evidence.js";

// ── THE ROUND'S EVIDENCE IS THE PLATFORM'S (docs/architecture/benchmark-evidence-spec.md §3) ─────────
describe("roundEvidenceOf", () => {
  it("flags each compared case as held-out / target, names its per-case verdict, and points at its runs", () => {
    const evidence = roundEvidenceOf({
      campaignId: "evc_1",
      seq: 2,
      frameDigest: "sha256:frame",
      frame: {
        scenarios: [
          { id: "t1", heldOut: false },
          { id: "h1", heldOut: true },
          { id: "h2", heldOut: true },
        ],
        targets: ["t1"],
      },
      baseline: { scorecardId: "sc-b", version: "1.0.0", results: [{ caseId: "t1", runId: "run-b1", trial: 0 }] },
      candidate: {
        scorecardId: "sc-c",
        version: "1.0.1",
        results: [
          { caseId: "t1", runId: "run-c1", trial: 0 },
          { caseId: "t1", runId: "run-c2", trial: 1 },
          { caseId: "h2", runId: "run-c3" },
        ],
      },
      trials: {
        cases: [
          {
            caseId: "t1",
            baselineRate: 0,
            baselineTrials: 5,
            candidateRate: 1,
            candidateTrials: 5,
            delta: 1,
            significant: true,
            p: 0.008,
            method: "fisher",
          },
          {
            caseId: "h1",
            baselineRate: 0.6,
            baselineTrials: 5,
            candidateRate: 0.6,
            candidateTrials: 5,
            delta: 0,
            significant: false,
          },
          {
            caseId: "h2",
            baselineRate: 0.8,
            baselineTrials: 5,
            candidateRate: 0.2,
            candidateTrials: 5,
            delta: -0.6,
            significant: true,
          },
        ],
      },
      verdict: {
        comparable: true,
        significantImprovements: 1,
        significantRegressions: 1,
        heldOut: { improvements: 0, regressions: 1 },
      },
      at: "2026-09-02T00:00:00.000Z",
    });
    expect(evidence.cases.map((c) => [c.caseId, c.heldOut, c.target, c.verdict])).toEqual([
      ["t1", false, true, "improved"],
      ["h1", true, false, "unchanged"],
      ["h2", true, false, "regressed"],
    ]);
    expect(evidence.cases[0]?.traces).toEqual([
      { side: "baseline", runId: "run-b1", trial: 0 },
      { side: "candidate", runId: "run-c1", trial: 0 },
      { side: "candidate", runId: "run-c2", trial: 1 },
    ]);
    expect(evidence.cases[2]?.traces).toEqual([{ side: "candidate", runId: "run-c3" }]);
    expect(evidence.aggregate.heldOut).toEqual({ improvements: 0, regressions: 1 });
  });
  it("a moved-but-not-significant case is `unclear`, and a round with no trials has no cases — never invented ones", () => {
    const base = {
      campaignId: "evc_1",
      seq: 1,
      frameDigest: "d",
      frame: { scenarios: [{ id: "c1", heldOut: true }], targets: [] },
      baseline: { scorecardId: "b", version: "1" },
      candidate: { scorecardId: "c", version: "2" },
      verdict: { comparable: false, significantImprovements: 0, significantRegressions: 0, detail: "no trial signal" },
      at: "t",
    };
    expect(roundEvidenceOf(base).cases).toEqual([]);
    const moved = roundEvidenceOf({
      ...base,
      trials: {
        cases: [
          {
            caseId: "c1",
            baselineRate: 0.2,
            baselineTrials: 3,
            candidateRate: 0.4,
            candidateTrials: 3,
            delta: 0.2,
            significant: false,
          },
        ],
      },
    });
    expect(moved.cases[0]?.verdict).toBe("unclear");
  });
  it("the key carries the digest, so two stagings of one round cannot share a name", () => {
    expect(roundEvidenceKey("evc_1", 3, "sha256:abcdef0123456789ff")).toBe(
      "campaigns/evc_1/rounds/3/abcdef012345.json",
    );
    expect(roundEvidenceKey("evc_1", 3, "sha256:0000000000000000ff")).not.toBe(
      roundEvidenceKey("evc_1", 3, "sha256:abcdef0123456789ff"),
    );
  });
});
