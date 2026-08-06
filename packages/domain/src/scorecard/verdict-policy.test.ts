import type { Score, VerdictPolicy } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VERDICT_POLICY,
  evaluateVerdict,
  resolveVerdictPolicy,
  verdictPolicyDigest,
  verdictPolicyRef,
} from "./verdict-policy.js";

const s = (metric: string, pass?: boolean, value = 0): Score => ({ graderId: metric, metric, value, pass });

describe("evaluateVerdict — the verdict explains itself", () => {
  it("states which rung decided and from which measurements", () => {
    const { verdict, basis } = evaluateVerdict({
      scores: [s("state", true), s("judge:quality", false)],
    });
    expect(verdict).toBe(true);
    expect(basis).toEqual({
      authority: "ground_truth",
      aggregation: "priority",
      deciders: [{ metric: "state", graderId: "state", pass: true }],
    });
  });

  it("ground truth is priority-ordered: state beats tests_pass when both decide", () => {
    // Declaration order in the policy is the priority — the historical for-loop semantics, now as data.
    const { verdict, basis } = evaluateVerdict({ scores: [s("tests_pass", false), s("state", true)] });
    expect(verdict).toBe(true);
    expect(basis?.deciders[0]?.metric).toBe("state");
  });

  it("a duplicate metric combines unanimously — never last-wins", () => {
    // Regression: the old Map(byMetric) silently kept the LAST score of a duplicated metric, so the verdict
    // depended on emission order. Duplicates now vote unanimously within the metric name.
    expect(evaluateVerdict({ scores: [s("tests_pass", false), s("tests_pass", true)] }).verdict).toBe(false);
    expect(evaluateVerdict({ scores: [s("tests_pass", true), s("tests_pass", false)] }).verdict).toBe(false);
  });

  it("the fallback basis names itself as fallback — an unranked verdict is visibly unranked", () => {
    const { verdict, basis } = evaluateVerdict({ scores: [s("custom_check", true)] });
    expect(verdict).toBe(true);
    expect(basis?.authority).toBe("fallback");
  });

  it("a strict policy (fallback none) refuses to let undeclared metrics decide", () => {
    const strict: VerdictPolicy = { ...DEFAULT_VERDICT_POLICY, fallback: "none" };
    expect(evaluateVerdict({ scores: [s("custom_check", true)] }, strict)).toEqual({});
  });

  it("a majority judge rung outvotes a single dissenter when the policy says so", () => {
    const majority: VerdictPolicy = {
      ...DEFAULT_VERDICT_POLICY,
      rungs: { ...DEFAULT_VERDICT_POLICY.rungs, judge: "majority" },
    };
    const scores = [s("judge:a", true), s("judge:b", true), s("judge:c", false)];
    expect(evaluateVerdict({ scores }, majority).verdict).toBe(true);
    expect(evaluateVerdict({ scores }, DEFAULT_VERDICT_POLICY).verdict).toBe(false); // default stays unanimous
  });

  it("an infra-failed case yields no verdict and no basis under any policy", () => {
    const failure = { stage: "dispatch", class: "infra", code: "X", message: "m", retryable: true } as const;
    expect(evaluateVerdict({ scores: [s("state", true)], failure })).toEqual({});
  });
});

describe("verdict policy identity", () => {
  it("the digest is stable across key order and changes when the document changes", () => {
    const ref = verdictPolicyRef();
    expect(ref).toEqual({
      id: "authority-ladder",
      version: "1.0.0",
      digest: verdictPolicyDigest(DEFAULT_VERDICT_POLICY),
    });
    const edited: VerdictPolicy = { ...DEFAULT_VERDICT_POLICY, fallback: "none" };
    expect(verdictPolicyDigest(edited)).not.toBe(ref.digest);
  });

  it("resolveVerdictPolicy finds the stamped policy and falls back to the ladder for pre-stamp records", () => {
    expect(resolveVerdictPolicy({ id: "authority-ladder", version: "1.0.0" })).toBe(DEFAULT_VERDICT_POLICY);
    expect(resolveVerdictPolicy(undefined)).toBe(DEFAULT_VERDICT_POLICY);
  });
});
