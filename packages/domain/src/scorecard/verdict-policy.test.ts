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

  it("a REQUIRED metric with no measurement invalidates the case — and the absence states its cause", () => {
    const strict: VerdictPolicy = {
      ...DEFAULT_VERDICT_POLICY,
      metrics: [
        { match: { metric: "tests_pass" }, authority: "ground_truth", verdictRole: "required" },
        ...DEFAULT_VERDICT_POLICY.metrics,
      ],
    };
    // the required metric is only UNMEASURED (grader died) — a judge alone must not carry the verdict
    const scores: Score[] = [
      { graderId: "tests-pass", metric: "tests_pass", value: 0, status: "unmeasured", reason: "grader_error" },
      s("judge:quality", true),
    ];
    expect(evaluateVerdict({ scores }, strict)).toEqual({
      invalidated: { reason: "required_metric_missing", metric: "tests_pass" },
    });
    // with the measurement present the same policy decides normally
    expect(evaluateVerdict({ scores: [s("tests_pass", true)] }, strict).verdict).toBe(true);
    // missingPolicy exclude_metric: proceed without it — the judge decides
    const lax: VerdictPolicy = {
      ...strict,
      metrics: strict.metrics.map((d, i) => (i === 0 ? { ...d, missingPolicy: "exclude_metric" as const } : d)),
    };
    expect(evaluateVerdict({ scores }, lax).verdict).toBe(true);
  });

  it("diagnostic/excluded metrics explain or observe — they never decide", () => {
    const policy: VerdictPolicy = {
      ...DEFAULT_VERDICT_POLICY,
      metrics: [
        { match: { metric: "advisory_check" }, authority: "objective", verdictRole: "diagnostic" },
        ...DEFAULT_VERDICT_POLICY.metrics,
      ],
    };
    // the failing diagnostic cannot veto the passing judge
    expect(evaluateVerdict({ scores: [s("advisory_check", false), s("judge:q", true)] }, policy).verdict).toBe(true);
    // and alone it decides nothing
    expect(evaluateVerdict({ scores: [s("advisory_check", false)] }, policy)).toEqual({});
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
