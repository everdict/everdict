import { describe, expect, it } from "vitest";
import { type GateInput, evaluateGate } from "./gate.js";

const base = (over: Partial<GateInput>): GateInput => ({
  baseline: "b",
  candidate: "c",
  metrics: [],
  regressions: [],
  improvements: [],
  missing: { casesOnlyInBaseline: [], casesOnlyInCandidate: [], metricsOnlyInBaseline: [], metricsOnlyInCandidate: [] },
  incomparable: [],
  overlap: { sharedCases: 3, baselineCases: 3, candidateCases: 3 },
  comparability: "full",
  ...over,
});

describe("evaluateGate — the release gate over the trust kernel's comparability", () => {
  it("an incomparable pair is NOT_COMPARABLE, never a false pass", () => {
    const g = evaluateGate(
      base({ comparability: "none", overlap: { sharedCases: 0, baselineCases: 3, candidateCases: 2 } }),
      {
        maxRegressions: 0,
      },
    );
    expect(g.decision).toBe("not_comparable");
    expect(g.reasons[0]?.kind).toBe("no_shared_cases");
  });

  it("a verdict-policy mismatch names the mismatch as the reason", () => {
    const g = evaluateGate(
      base({
        comparability: "none",
        policyMismatch: {
          baseline: { id: "p", version: "1", digest: "aaa" },
          candidate: { id: "p", version: "2", digest: "bbb" },
        },
      }),
      { maxRegressions: 0 },
    );
    expect(g.decision).toBe("not_comparable");
    expect(g.reasons[0]?.kind).toBe("policy_mismatch");
  });

  it("a regression blocks under maxRegressions 0 and the reason names the case", () => {
    const g = evaluateGate(
      base({
        regressions: [{ caseId: "x", metric: "tests_pass", baseline: 1, candidate: 0, delta: -1, passChange: "broke" }],
      }),
      { maxRegressions: 0 },
    );
    expect(g.decision).toBe("block");
    expect(g.reasons.find((r) => r.kind === "regression")?.caseId).toBe("x");
    expect(g.evidence).toMatchObject({ regressions: 1, trialsGated: false });
  });

  it("with trials, the Fisher-gated trial diff is authoritative — raw transitions never block on their own", () => {
    const g = evaluateGate(
      base({
        // Raw last-trial transitions show a flip, but the statistical gate says noise:
        regressions: [{ caseId: "x", metric: "tests_pass", baseline: 1, candidate: 0, delta: -1, passChange: "broke" }],
        trials: {
          baseline: "b",
          candidate: "c",
          zThreshold: 1.96,
          minDelta: 0.1,
          cases: [],
          regressions: [],
          improvements: [],
          missing: { casesOnlyInBaseline: [], casesOnlyInCandidate: [], unscoredCases: [] },
        },
      }),
      { maxRegressions: 0 },
    );
    expect(g.decision).toBe("pass");
    expect(g.evidence.trialsGated).toBe(true);
  });

  it("kind-changed metrics ride as informational reasons on a pass", () => {
    const g = evaluateGate(base({ incomparable: [{ metric: "tier", reason: "kind_changed" }] }), { maxRegressions: 0 });
    expect(g.decision).toBe("pass");
    expect(g.reasons.map((r) => r.kind)).toEqual(["kind_changed"]);
  });
});
