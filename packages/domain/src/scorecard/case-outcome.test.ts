import type { CaseFailure, CaseResult, Scorecard } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { caseOutcome, scorecardOutcomes } from "./case-outcome.js";
import { scorecardPassRate } from "./scorecard.js";

const result = (caseId: string, opts: { pass?: boolean; failure?: CaseFailure; noScores?: boolean }): CaseResult => ({
  caseId,
  harness: "h@1",
  trace: [],
  snapshot: { kind: "prompt", output: "" },
  scores: opts.noScores
    ? []
    : [{ graderId: "tests-pass", metric: "tests_pass", value: opts.pass ? 1 : 0, pass: opts.pass ?? false }],
  ...(opts.failure ? { failure: opts.failure } : {}),
});

const infraFailure = (stage: CaseFailure["stage"]): CaseFailure => ({
  stage,
  class: "infra",
  code: "UPSTREAM_ERROR",
  message: "node drained",
  retryable: true,
});

describe("caseOutcome — the case's fate as a first-class value", () => {
  it("a dispatch/install/run failure is infra_failed with NO product verdict", () => {
    for (const stage of ["dispatch", "install", "run"] as const) {
      const r = result("a", { pass: true, failure: infraFailure(stage) });
      expect(caseOutcome(r)).toMatchObject({ status: "infra_failed" });
    }
  });

  it("a collect/grade-stage failure keeps the surviving measurements' verdict (partial results by design)", () => {
    // The run completed; only trace collection died. The compute-bound tests_pass measurement still stands.
    const r = result("a", { pass: true, failure: infraFailure("collect") });
    expect(caseOutcome(r)).toEqual({ status: "completed", verdict: true });
  });

  it("a clean run with nothing pass-deciding is unmeasured — not a FAIL", () => {
    expect(caseOutcome(result("a", { noScores: true }))).toEqual({ status: "unmeasured" });
  });

  it("a clean run with a deciding measurement is completed", () => {
    expect(caseOutcome(result("a", { pass: false }))).toEqual({ status: "completed", verdict: false });
  });
});

describe("scorecardOutcomes — denominators that never conflate platform and product", () => {
  const sc: Scorecard = {
    suiteId: "s",
    harness: "h@1",
    results: [
      result("a", { pass: true }),
      result("b", { pass: false }),
      result("c", { failure: infraFailure("dispatch") }),
      result("d", { noScores: true }),
    ],
  };

  it("splits executed/gradeable/verdicted and tallies each fate once", () => {
    expect(scorecardOutcomes(sc, 6)).toEqual({
      requested: 6, // 2 more were never launched (cancelled) — requested − executed
      executed: 4,
      gradeable: 3,
      verdicted: 2,
      passed: 1,
      failed: 1,
      infraFailed: 1,
      unmeasured: 1,
    });
  });

  it("CORE INVARIANT: injecting an infra failure changes pass rate by nothing", () => {
    // Given: a clean scorecard and the same one with a dispatched-failed case added
    const clean: Scorecard = {
      suiteId: "s",
      harness: "h@1",
      results: [result("a", { pass: true }), result("b", { pass: false })],
    };
    const injected: Scorecard = {
      ...clean,
      results: [...clean.results, result("z", { failure: infraFailure("dispatch") })],
    };
    // Then: the product pass rate is bit-identical — the failure shows up ONLY in infraFailed
    expect(scorecardPassRate(injected)).toEqual(scorecardPassRate(clean));
    expect(scorecardOutcomes(injected).infraFailed).toBe(1);
    expect(scorecardOutcomes(injected).verdicted).toBe(scorecardOutcomes(clean).verdicted);
  });
});
