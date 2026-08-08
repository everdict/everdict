import type { CaseResult, Score } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { appendScoringRevision, currentScoringPin, scorePlaneDigest } from "./scoring-revision.js";

// Scoring identity (arch-review 6): the live score plane mutates in place on a re-score, so identity lives
// in an append-only revision ledger digesting the plane each pass left behind. These tests pin the digest's
// semantics (judgment, not narration; content, not storage order) and the ledger's append discipline.

function result(caseId: string, scores: Score[], trial?: number): CaseResult {
  return {
    caseId,
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "done" },
    scores,
    ...(trial !== undefined ? { trial } : {}),
  };
}

const verdict = (value: number, pass: boolean): Score => ({ graderId: "j", metric: "judge:j", value, pass });

describe("scorePlaneDigest — the judgment plane, canonically", () => {
  it("is stable under storage order (case order and score order are not content)", () => {
    const a = [
      result("c1", [verdict(1, true), { graderId: "tests", metric: "tests_pass", value: 1, pass: true }]),
      result("c2", [verdict(0, false)]),
    ];
    const b = [
      result("c2", [verdict(0, false)]),
      result("c1", [{ graderId: "tests", metric: "tests_pass", value: 1, pass: true }, verdict(1, true)]),
    ];
    expect(scorePlaneDigest(a)).toBe(scorePlaneDigest(b));
  });

  it("moves when a judgment moves — a re-scored verdict is a different plane", () => {
    const before = [result("c1", [verdict(1, true)])];
    const after = [result("c1", [verdict(0, false)])];
    expect(scorePlaneDigest(before)).not.toBe(scorePlaneDigest(after));
  });

  it("ignores narration — a judge re-wording its rationale is the same judgment", () => {
    const unmeasured = (detail: string): Score => ({
      graderId: "j",
      metric: "judge:j",
      status: "unmeasured",
      reason: "grader_error",
      retryable: true,
      detail,
    });
    expect(scorePlaneDigest([result("c1", [unmeasured("transport died")])])).toBe(
      scorePlaneDigest([result("c1", [unmeasured("the LLM call timed out")])]),
    );
  });

  it("keeps trials apart — c1#0 and c1#1 are different rows of the plane", () => {
    expect(scorePlaneDigest([result("c1", [verdict(1, true)], 0), result("c1", [verdict(0, false)], 1)])).not.toBe(
      scorePlaneDigest([result("c1", [verdict(0, false)], 0), result("c1", [verdict(1, true)], 1)]),
    );
  });
});

describe("appendScoringRevision / currentScoringPin — the append-only ledger", () => {
  const results = [result("c1", [verdict(1, true)])];

  it("numbers passes 1-based and strictly increasing, preserving prior entries verbatim", () => {
    const first = appendScoringRevision(undefined, {
      kind: "initial",
      judges: [{ id: "j", version: "1.0.0", model: "m1" }],
      results,
      createdAt: "t1",
      createdBy: "alice",
    });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ revision: 1, kind: "initial", createdBy: "alice" });
    const second = appendScoringRevision(first, {
      kind: "rescore",
      judges: [{ id: "j", version: "2.0.0", model: "m2" }],
      results: [result("c1", [verdict(0, false)])],
      createdAt: "t2",
    });
    expect(second).toHaveLength(2);
    expect(second[0]).toEqual(first[0]); // append-only: history is never rewritten
    expect(second[1]).toMatchObject({ revision: 2, kind: "rescore" });
    expect(second[1]?.scorePlaneDigest).not.toBe(second[0]?.scorePlaneDigest);
  });

  it("pins the CURRENT revision for a gate, and pins nothing on a pre-ledger record", () => {
    const ledger = appendScoringRevision(undefined, {
      kind: "initial",
      judges: [],
      results,
      createdAt: "t1",
    });
    expect(currentScoringPin(ledger)).toEqual({
      revision: 1,
      scorePlaneDigest: ledger[0]?.scorePlaneDigest,
    });
    expect(currentScoringPin(undefined)).toBeUndefined();
    expect(currentScoringPin([])).toBeUndefined();
  });
});
