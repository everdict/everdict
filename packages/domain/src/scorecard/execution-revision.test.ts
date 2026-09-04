import type { CaseAttempt, CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  attemptsForCase,
  keysRequiringReason,
  nextExecutionRevision,
  retryReasonRequired,
  retrySummaryOf,
  supersedeAttempts,
} from "./execution-revision.js";

const result = (caseId: string, over: Partial<CaseResult> = {}): CaseResult => ({
  caseId,
  harness: "h@1.0.0",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "0".repeat(40) },
  scores: [],
  ...over,
});

// A case that reached a real verdict — the shape `retryReasonRequired` exists to catch.
const decided = (caseId: string, pass: boolean): CaseResult =>
  result(caseId, { scores: [{ graderId: "tests-pass", metric: "tests_pass", value: pass ? 1 : 0, pass }] });

// A case the platform killed before it could measure anything.
const infraDead = (caseId: string): CaseResult =>
  result(caseId, {
    failure: { code: "DISPATCH_FAILED", message: "no capacity", stage: "dispatch", class: "infra", retryable: true },
  });

const attempt = (caseId: string, n: number, over: Partial<CaseAttempt> = {}): CaseAttempt => ({
  caseId,
  attempt: n,
  revision: n,
  supersededAt: "2026-09-04T00:00:00.000Z",
  result: result(caseId),
  ...over,
});

describe("attempt counting — the ledger is the number, never a stored counter", () => {
  it("counts one attempt for a case that has never been retried", () => {
    expect(attemptsForCase(undefined, { caseId: "c1" })).toBe(1);
    expect(attemptsForCase([], { caseId: "c1" })).toBe(1);
  });

  it("counts the current attempt plus every superseded one", () => {
    expect(attemptsForCase([attempt("c1", 1), attempt("c1", 2)], { caseId: "c1" })).toBe(3);
  });

  it("keeps trials apart — (c1, trial 0) and (c1, trial 1) are different executions", () => {
    // Given one superseded attempt on trial 0 only …
    const ledger = [attempt("c1", 1, { trial: 0 })];
    // … then trial 1 has still only ever run once. A count that folded the trial axis away would say 2,
    // and pass@k over that case would then be reading a retry as a repetition.
    expect(attemptsForCase(ledger, { caseId: "c1", trial: 0 })).toBe(2);
    expect(attemptsForCase(ledger, { caseId: "c1", trial: 1 })).toBe(1);
  });

  it("does not confuse a case whose id contains the key separator with another case", () => {
    // `encodeCaseKey` escapes `#`; a naive `${caseId}#${trial}` would make these two the same key.
    const ledger = [attempt("c#1", 1)];
    expect(attemptsForCase(ledger, { caseId: "c", trial: 1 })).toBe(1);
    expect(attemptsForCase(ledger, { caseId: "c#1" })).toBe(2);
  });

  it("summarizes distinct cases separately from total attempts", () => {
    // One case retried twice and another retried once is 2 cases / 3 attempts — a single number would
    // report 3 cases or 2 attempts, and both readings are wrong.
    expect(retrySummaryOf([attempt("c1", 1), attempt("c1", 2), attempt("c2", 1)])).toEqual({
      cases: 2,
      attempts: 3,
    });
  });
});

describe("revision numbering — strictly increasing over what the record holds", () => {
  it("starts at 1 on a record that has never had an execution pass", () => {
    expect(nextExecutionRevision(undefined)).toBe(1);
  });

  it("takes the MAX, not the length — a removed revision must never be re-issued", () => {
    const revisions = [
      { revision: 1, kind: "initial" as const, cases: [], createdAt: "t" },
      { revision: 3, kind: "retry" as const, cases: [], createdAt: "t" },
    ];
    // length + 1 would answer 3, which is a number already taken: two revisions would then claim one
    // identity and a gate pinning revision 3 could not say which plane it read.
    expect(nextExecutionRevision(revisions)).toBe(4);
  });
});

describe("a retry that launders a verdict is permitted and never silent", () => {
  it("requires no reason for a case that never produced a measurement", () => {
    expect(retryReasonRequired(infraDead("c1"))).toBe(false);
  });

  it("requires a reason for a case that COMPLETED — in both directions", () => {
    // Re-running a FAIL until it passes is the obvious abuse; re-running a PASS is the same act with the
    // sign flipped, and a predicate that only guarded one direction would bless it.
    expect(retryReasonRequired(decided("c1", false))).toBe(true);
    expect(retryReasonRequired(decided("c1", true))).toBe(true);
  });

  it("names exactly the requested keys that carry a verdict", () => {
    const plane = [decided("c1", false), infraDead("c2")];
    expect(keysRequiringReason(plane, [{ caseId: "c1" }, { caseId: "c2" }])).toEqual([{ caseId: "c1" }]);
  });

  it("says nothing about a key that is not on the plane — there is no verdict to launder", () => {
    expect(keysRequiringReason([decided("c1", false)], [{ caseId: "nope" }])).toEqual([]);
  });
});

describe("supersede — the newest attempt is the answer and the old one is kept", () => {
  const base = { attempts: undefined, revision: 2, at: "2026-09-04T01:00:00.000Z", by: "alice" };

  it("replaces the current result and moves the old one to the ledger whole", () => {
    const old = infraDead("c1");
    const fresh = decided("c1", true);
    const out = supersedeAttempts({ ...base, results: [old, decided("c2", true)], retried: [fresh] });

    expect(out.results[0]).toBe(fresh);
    expect(out.superseded).toEqual([
      {
        caseId: "c1",
        attempt: 1,
        revision: 2,
        supersededAt: base.at,
        supersededBy: "alice",
        result: old,
      },
    ]);
    expect(out.cases).toEqual([{ caseId: "c1", attempt: 2, replaced: true }]);
  });

  it("leaves every other case exactly where it was", () => {
    // Positional identity matters: consumers index this plane in places this module cannot see, and a
    // retry is not a reason for a case to move.
    const plane = [decided("a", true), infraDead("b"), decided("c", false)];
    const out = supersedeAttempts({ ...base, results: plane, retried: [decided("b", true)] });
    expect(out.results.map((r) => r.caseId)).toEqual(["a", "b", "c"]);
    expect(out.results[0]).toBe(plane[0]);
    expect(out.results[2]).toBe(plane[2]);
  });

  it("numbers the new attempt from the ledger, so a second retry is attempt 3", () => {
    const out = supersedeAttempts({
      ...base,
      attempts: [attempt("c1", 1)],
      results: [infraDead("c1")],
      retried: [decided("c1", true)],
    });
    expect(out.superseded[0]?.attempt).toBe(2);
    expect(out.cases).toEqual([{ caseId: "c1", attempt: 3, replaced: true }]);
  });

  it("carries the trial onto both the ledger entry and the revision entry", () => {
    const out = supersedeAttempts({
      ...base,
      results: [infraDead("c1"), result("c1", { trial: 1 })],
      retried: [result("c1", { trial: 1, scores: decided("c1", true).scores })],
    });
    expect(out.superseded[0]).toMatchObject({ caseId: "c1", trial: 1, attempt: 1 });
    expect(out.cases).toEqual([{ caseId: "c1", trial: 1, attempt: 2, replaced: true }]);
  });

  it("REFUSES a retried result for a key the batch never sealed", () => {
    // A retry may not add a case. Appending it would put a case into a sealed batch that the manifest
    // never covered — the dataset decided by a retry, which rule `suite` calls a new semantic decision.
    const out = supersedeAttempts({ ...base, results: [decided("c1", true)], retried: [decided("ghost", true)] });
    expect(out.results.map((r) => r.caseId)).toEqual(["c1"]);
    expect(out.superseded).toEqual([]);
    expect(out.cases).toEqual([{ caseId: "ghost", attempt: 1, replaced: false }]);
  });

  it("keeps the old result when the pass produced nothing for a case", () => {
    // A pass that dispatched and came back empty must not be able to EMPTY the case: downstream that
    // reads as a batch which shrank, not as a retry that failed.
    const old = infraDead("c1");
    const out = supersedeAttempts({ ...base, results: [old], retried: [] });
    expect(out.results).toEqual([old]);
    expect(out.superseded).toEqual([]);
    expect(out.cases).toEqual([]);
  });
});
