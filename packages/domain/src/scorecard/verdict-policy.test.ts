import type { Score, VerdictPolicy } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VERDICT_POLICY,
  composeVerdictPolicy,
  evaluateVerdict,
  resolvePolicyResolution,
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

  it("a registered stamp resolves to its exact document", () => {
    expect(resolvePolicyResolution({ id: "authority-ladder", version: "1.0.0" })).toEqual({
      status: "resolved",
      policy: DEFAULT_VERDICT_POLICY,
    });
    expect(resolvePolicyResolution(verdictPolicyRef())).toEqual({
      status: "resolved",
      policy: DEFAULT_VERDICT_POLICY,
    });
  });

  it("a record with NO stamp is legacy_default — not the same answer as a stamp that resolved", () => {
    // Pre-mig-0125 rows really were judged under the ladder the default encodes, so restoring it is history,
    // not a fallback. The status distinguishes it from a resolved stamp so a reader can tell the two apart.
    expect(resolvePolicyResolution(undefined)).toEqual({ status: "legacy_default", policy: DEFAULT_VERDICT_POLICY });
  });

  it("a stamp naming a policy nobody has is UNRESOLVABLE — never the default ladder", () => {
    // Regression (fail-open): the old resolver answered DEFAULT_VERDICT_POLICY here, so a batch judged under a
    // policy this deployment no longer has was silently re-judged under today's ladder.
    const ref = { id: "authority-ladder", version: "9.9.9", digest: "deadbeef" };
    expect(resolvePolicyResolution(ref)).toEqual({ status: "unresolvable", ref });
  });

  it("a registry hit whose document no longer matches the stamped digest is unresolvable", () => {
    // KNOWN_VERDICT_POLICIES is append-only by contract: an id@version that stopped hashing to the stamp is a
    // document that was EDITED, and it cannot restore the history the stamp points at.
    const ref = { id: "authority-ladder", version: "1.0.0", digest: "not-the-real-digest" };
    expect(resolvePolicyResolution(ref)).toEqual({ status: "unresolvable", ref });
  });
});

describe("composeVerdictPolicy — a custom grader gains authority by DECLARING it", () => {
  it("a declared objective grader decides its metric with no domain-code edit", () => {
    const policy = composeVerdictPolicy([{ id: "schema_valid", authority: "objective" }]);
    expect(policy.id).toBe("composed");
    // the declared metric now OVERRULES a judge (objective rung > judge rung)
    const { verdict, basis } = evaluateVerdict({ scores: [s("schema_valid", false), s("judge:q", true)] }, policy);
    expect(verdict).toBe(false);
    expect(basis?.authority).toBe("objective");
    // under the default (undeclared) policy the same metric only reaches the fallback
    expect(evaluateVerdict({ scores: [s("schema_valid", false), s("judge:q", true)] }).verdict).toBe(true);
  });

  it("a declared ground truth never OUTRANKS the built-ins — additions append after state/tests_pass", () => {
    const policy = composeVerdictPolicy([{ id: "custom_state", authority: "ground_truth" }]);
    const { verdict } = evaluateVerdict({ scores: [s("state", true), s("custom_state", false)] }, policy);
    expect(verdict).toBe(true); // priority rung: state (built-in, first) still decides
  });

  it("no declarations returns the base policy object itself", () => {
    expect(composeVerdictPolicy([{ id: "steps" }])).toBe(DEFAULT_VERDICT_POLICY);
  });

  it("an embedded document is trusted only when its digest matches the stamp", () => {
    const composed = composeVerdictPolicy([{ id: "schema_valid", authority: "objective" }]);
    const ref = verdictPolicyRef(composed);
    expect(resolvePolicyResolution(ref, composed)).toEqual({ status: "resolved", policy: composed });
  });

  it("a TAMPERED embedded document is unresolvable — it never falls back to the default ladder", () => {
    // Regression (fail-open): the mismatch used to hand back DEFAULT_VERDICT_POLICY, so editing a manifest
    // did not rewrite the verdict — it silently re-derived every verdict under the built-in ladder instead,
    // which is the same retroactive rewrite by another route.
    const composed = composeVerdictPolicy([{ id: "schema_valid", authority: "objective" }]);
    const ref = verdictPolicyRef(composed);
    const tampered = { ...composed, fallback: "none" as const };
    expect(resolvePolicyResolution(ref, tampered)).toEqual({ status: "unresolvable", ref });
  });

  it("a COMPOSED stamp with no embedded document is unresolvable — the list-path guard", () => {
    // A composed policy lives ONLY in its record's manifest, and list reads do not load the manifest. Since
    // id "composed" can never be in the append-only registry, resolving without the document is structurally
    // impossible — so any list-path reader gets `unresolvable`, never a silent default.
    const composed = composeVerdictPolicy([{ id: "schema_valid", authority: "objective" }]);
    const ref = verdictPolicyRef(composed);
    expect(resolvePolicyResolution(ref)).toEqual({ status: "unresolvable", ref });
  });
});
