import { type CaseResult, CaseResultSchema } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { contentDigest } from "../provenance/content-digest.js";
import { caseResultDigest } from "./case-result-digest.js";

// Regression (review 40 follow-up): the receipt's digest is compared across a schema round-trip — the
// in-process producer literal on one side, the jsonb row ScoreSchema's read-time normalizer has stamped on
// the other. A raw contentDigest tells those two apart (that is the pre-fix failure: every Pg-backed batch
// read as divergent and the fail-closed gate refused it); caseResultDigest must not.
describe("caseResultDigest — one digest across the schema round-trip", () => {
  // What a grader literally writes: no `status` on the measured score (the producer-literal shape).
  const producerLiteral: CaseResult = {
    caseId: "c1",
    harness: "h@1.0.0",
    trace: [],
    snapshot: { kind: "prompt", output: "" },
    scores: [{ graderId: "g", metric: "pass", value: 1, pass: true }],
  };

  it("digests the producer literal and its parsed (normalized) twin identically", () => {
    const roundTripped = CaseResultSchema.parse(JSON.parse(JSON.stringify(producerLiteral)));
    // The premise: the round trip really does change the shape (the normalizer stamps `status`), so a raw
    // shape hash tells the two apart — this is the exact pre-fix defect, pinned so it cannot quietly heal.
    expect(contentDigest(producerLiteral)).not.toBe(contentDigest(roundTripped));
    // The fix: one spelling, both sides parsed first.
    expect(caseResultDigest(producerLiteral)).toBe(caseResultDigest(roundTripped));
  });

  it("still tells two DIFFERENT measurements apart", () => {
    const failing: CaseResult = {
      ...producerLiteral,
      scores: [{ graderId: "g", metric: "pass", value: 0, pass: false }],
    };
    expect(caseResultDigest(producerLiteral)).not.toBe(caseResultDigest(failing));
  });
});
