import type { GateScoringPin } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type GateEvaluation, type GateInput, applyInputTrust, evaluateGate, refuseGateForInputTrust } from "./gate.js";

const base = (over: Partial<GateInput>): GateInput => ({
  baseline: "b",
  candidate: "c",
  metrics: [],
  regressions: [],
  improvements: [],
  caseTransitions: [],
  metricCoverage: [],
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

  it("an unrestorable stamped policy is NOT_COMPARABLE even when the diff still claims to be comparable", () => {
    // The analytics layer forces comparability "none" on this, but the gate refuses on its own: a side whose
    // verdicts cannot be re-derived has nothing for a release decision to stand on, and a gate that only
    // refuses when someone else remembered to mark the diff is one forgotten line from a false green light.
    const g = evaluateGate(
      base({
        comparability: "full",
        policyUnresolvable: { candidate: { id: "composed", version: "0a1b2c3d", digest: "no-such-document" } },
        // The leak shape: transitions somebody upstream still computed. The refusal must not repeat them.
        regressions: [{ caseId: "x", metric: "tests_pass", baseline: 1, candidate: 0, delta: -1, passChange: "broke" }],
        caseTransitions: [{ caseId: "x", baseline: true, candidate: false, change: "broke" }],
      }),
      { maxRegressions: 0 },
    );
    expect(g.decision).toBe("not_comparable");
    expect(g.reasons[0]?.kind).toBe("policy_unresolvable");
    expect(g.reasons[0]?.detail).toContain("no-such-document");
    expect(g.evidence.comparability).toBe("none");
    // Unknown policy means unknown verdict: the refusal carries NO regression numbers — the pre-fix order
    // computed them first and the not_comparable decision spread "regressions: 1" into persisted evidence.
    expect(g.evidence.regressions).toBeUndefined();
    expect(g.evidence.improvements).toBeUndefined();
  });

  it("a comparability-none refusal carries no verdict-derived numbers either — structure only", () => {
    const g = evaluateGate(
      base({
        comparability: "none",
        caseTransitions: [{ caseId: "x", baseline: true, candidate: false, change: "broke" }],
      }),
      { maxRegressions: 0 },
    );
    expect(g.decision).toBe("not_comparable");
    expect(g.evidence.regressions).toBeUndefined();
    expect(g.evidence.improvements).toBeUndefined();
    expect(g.evidence.missingCases).toBeDefined(); // the structural half still rides
  });

  it("a regression blocks under maxRegressions 0 and the reason names the case", () => {
    const g = evaluateGate(
      base({
        regressions: [{ caseId: "x", metric: "tests_pass", baseline: 1, candidate: 0, delta: -1, passChange: "broke" }],
        caseTransitions: [{ caseId: "x", baseline: true, candidate: false, change: "broke" }],
      }),
      { maxRegressions: 0 },
    );
    expect(g.decision).toBe("block");
    const reason = g.reasons.find((r) => r.kind === "regression");
    expect(reason?.caseId).toBe("x");
    expect(reason?.detail).toContain("tests_pass"); // the metric flip rides as diagnosis, not as its own count
    expect(g.evidence).toMatchObject({ regressions: 1, trialsGated: false });
  });

  it("a diagnostic metric flip on a case whose VERDICT still passes never blocks — the regression unit is the case verdict", () => {
    // Given a case whose ground truth passed on both sides while a judge metric flipped true → false
    const g = evaluateGate(
      base({
        regressions: [
          { caseId: "x", metric: "judge:quality", baseline: 1, candidate: 0, delta: -1, passChange: "broke" },
        ],
        caseTransitions: [{ caseId: "x", baseline: true, candidate: true, change: "same" }],
      }),
      { maxRegressions: 0 },
    );
    // Then the gate passes: the authority ladder says the case did NOT flip, and the gate does not
    // reinterpret the raw metric signal underneath that decision.
    expect(g.decision).toBe("pass");
    expect(g.evidence.regressions).toBe(0);
  });

  it("one case losing three pass-bearing metrics is ONE regression, not three", () => {
    const flips = ["tests_pass", "answer_match", "judge:quality"].map((metric) => ({
      caseId: "x",
      metric,
      baseline: 1,
      candidate: 0,
      delta: -1,
      passChange: "broke" as const,
    }));
    const g = evaluateGate(
      base({
        regressions: flips,
        caseTransitions: [{ caseId: "x", baseline: true, candidate: false, change: "broke" }],
      }),
      { maxRegressions: 0 },
    );
    expect(g.decision).toBe("block");
    expect(g.evidence.regressions).toBe(1);
    expect(g.reasons.filter((r) => r.kind === "regression")).toHaveLength(1);
  });

  it("with trials, the Fisher-gated trial diff is authoritative — raw transitions never block on their own", () => {
    const g = evaluateGate(
      base({
        // Raw last-trial transitions show a flip, but the statistical gate says noise:
        regressions: [{ caseId: "x", metric: "tests_pass", baseline: 1, candidate: 0, delta: -1, passChange: "broke" }],
        caseTransitions: [{ caseId: "x", baseline: true, candidate: false, change: "broke" }],
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

// A comparison that held over only part of what was asked used to run the SAME arithmetic as a complete one:
// zero regressions among the cases that survived came back as `pass`. The gate now refuses to read a verdict
// out of an incomplete comparison unless the caller says, in policy, that a subset is what it wants.
describe("evaluateGate — fail-closed on missingness", () => {
  // 100 baseline cases, 60 of them re-run by the candidate, no regressions among those 60.
  const shrunk = (over: Partial<GateInput> = {}): GateInput =>
    base({
      comparability: "partial",
      missing: {
        casesOnlyInBaseline: Array.from({ length: 40 }, (_, i) => `c${i}`),
        casesOnlyInCandidate: [],
        metricsOnlyInBaseline: [],
        metricsOnlyInCandidate: [],
      },
      overlap: { sharedCases: 60, baselineCases: 100, candidateCases: 60 },
      ...over,
    });

  it("a PARTIAL comparison is blocked_missing by default — 0 regressions over 60 of 100 cases is not a green light", () => {
    // Given a candidate that only ran 60 of the baseline's 100 cases, and regressed in none of them
    // When the gate decides under the default policy (no comparability stated)
    const g = evaluateGate(shrunk(), { maxRegressions: 0 });

    // Then it withholds the light and says which 40 cases it never saw
    expect(g.decision).toBe("blocked_missing");
    const reason = g.reasons.find((r) => r.kind === "missing_cases");
    expect(reason).toMatchObject({ count: 40, fraction: 0.4 });
    expect(g.evidence).toMatchObject({ comparability: "partial", regressions: 0, missingFraction: 0.4 });
  });

  it("a metric that vanished or changed kind blocks a require_full gate too — the comparison lost a column", () => {
    const g = evaluateGate(
      base({
        comparability: "partial",
        incomparable: [{ metric: "tier", reason: "kind_changed" }],
        missing: {
          casesOnlyInBaseline: [],
          casesOnlyInCandidate: [],
          metricsOnlyInBaseline: ["cost_usd"],
          metricsOnlyInCandidate: [],
        },
      }),
      { maxRegressions: 0 },
    );
    expect(g.decision).toBe("blocked_missing");
    // The vanished metric AND the kind-changed one are both losses of the comparison.
    expect(g.reasons.find((r) => r.kind === "missing_metrics")?.count).toBe(2);
  });

  it("allow_partial within the stated tolerance passes — a deliberate subset is a decision, not an accident", () => {
    const g = evaluateGate(shrunk(), {
      maxRegressions: 0,
      comparability: "allow_partial",
      maxMissingFraction: 0.5,
      maxMissingCases: 50,
    });
    expect(g.decision).toBe("pass");
    expect(g.reasons.filter((r) => r.kind === "missing_cases")).toEqual([]);
  });

  it("allow_partial beyond the stated tolerance is blocked_missing, and the reason names the limit it broke", () => {
    const byFraction = evaluateGate(shrunk(), {
      maxRegressions: 0,
      comparability: "allow_partial",
      maxMissingFraction: 0.1,
    });
    expect(byFraction.decision).toBe("blocked_missing");
    expect(byFraction.reasons.find((r) => r.kind === "missing_cases")?.detail).toContain("maxMissingFraction");

    const byCount = evaluateGate(shrunk(), { maxRegressions: 0, comparability: "allow_partial", maxMissingCases: 5 });
    expect(byCount.decision).toBe("blocked_missing");
    expect(byCount.reasons.find((r) => r.kind === "missing_cases")?.detail).toContain("maxMissingCases");
  });

  it("allow_partial with NO tolerance stated accepts any missingness — an unstated limit is not a limit", () => {
    const g = evaluateGate(shrunk(), { maxRegressions: 0, comparability: "allow_partial" });
    expect(g.decision).toBe("pass");
  });

  it("too much of the comparison being unmeasured blocks under EITHER mode — hollow scores are not evidence", () => {
    // Given a complete comparison whose candidate scores were 70% dead graders / skipped judges
    const hollow = base({
      coverage: {
        baseline: { scores: 100, unmeasured: 0, unmeasuredFraction: 0 },
        candidate: { scores: 100, unmeasured: 70, unmeasuredFraction: 0.7 },
      },
    });

    // When a policy that tolerates 20% unmeasured decides — under require_full AND allow_partial
    const strict = evaluateGate(hollow, { maxRegressions: 0, maxUnmeasuredFraction: 0.2 });
    const lenient = evaluateGate(hollow, {
      maxRegressions: 0,
      comparability: "allow_partial",
      maxUnmeasuredFraction: 0.2,
    });

    // Then both refuse: unmeasured scores never make a comparison `partial`, so gating this on the
    // comparability mode would make the limit unreachable.
    expect(strict.decision).toBe("blocked_missing");
    expect(lenient.decision).toBe("blocked_missing");
    expect(strict.reasons.find((r) => r.kind === "unmeasured_evidence")?.fraction).toBeCloseTo(0.7);
    expect(strict.evidence.unmeasuredFraction).toBeCloseTo(0.7);
    // The WORSE side decides — a hollow baseline makes "no regression" just as meaningless.
    expect(evaluateGate(hollow, { maxRegressions: 0, maxUnmeasuredFraction: 0.8 }).decision).toBe("pass");
  });

  it("without a stated maxUnmeasuredFraction the coverage rides as evidence only — the gate invents no limit", () => {
    const g = evaluateGate(
      base({
        coverage: {
          baseline: { scores: 10, unmeasured: 9, unmeasuredFraction: 0.9 },
          candidate: { scores: 10, unmeasured: 9, unmeasuredFraction: 0.9 },
        },
      }),
      { maxRegressions: 0 },
    );
    expect(g.decision).toBe("pass");
    expect(g.evidence.unmeasuredFraction).toBeCloseTo(0.9);
  });

  it("a blocked_missing decision still carries the regressions found in the overlap — the evidence never shrinks", () => {
    const g = evaluateGate(
      shrunk({
        regressions: [{ caseId: "x", metric: "tests_pass", baseline: 1, candidate: 0, delta: -1, passChange: "broke" }],
        caseTransitions: [{ caseId: "x", baseline: true, candidate: false, change: "broke" }],
      }),
      { maxRegressions: 0 },
    );
    expect(g.decision).toBe("blocked_missing");
    expect(g.reasons.map((r) => r.kind)).toEqual(["missing_cases", "regression"]);
    expect(g.evidence.regressions).toBe(1);
  });

  it("a comparison with no missingness is unaffected by the fail-closed default", () => {
    expect(evaluateGate(base({}), { maxRegressions: 0 }).decision).toBe("pass");
  });
});

// The one place where product judgment is allowed to precede statistics — and only because someone declared
// it. A login case going 3/3 → 0/3 is Fisher p=0.1: an honest "not significant", and a fully broken login
// that ships anyway. The pair of tests below is the whole argument: the statistical answer stays the default,
// the product answer is opt-in and named.
describe("evaluateGate — critical cases", () => {
  // 3/3 → 0/3 on one case, exactly the review's scenario: a total collapse the exact test cannot call.
  const collapsed = (caseId: string): NonNullable<GateInput["trials"]> => ({
    baseline: "b",
    candidate: "c",
    zThreshold: 1.96,
    minDelta: 0,
    cases: [
      {
        caseId,
        baselineRate: 1,
        baselineTrials: 3,
        candidateRate: 0,
        candidateTrials: 3,
        delta: -1,
        z: -2.45,
        method: "fisher",
        p: 0.1,
        significant: false, // p=0.1 — the trials diff correctly refuses to call this significant
      },
    ],
    regressions: [],
    improvements: [],
    missing: { casesOnlyInBaseline: [], casesOnlyInCandidate: [], unscoredCases: [] },
  });

  it("a 3/3 → 0/3 collapse PASSES when nothing was declared critical — the statistics are honest", () => {
    // Given a case that failed all three candidate trials, at a p the exact test cannot call significant
    // When no criticality is declared
    const g = evaluateGate(base({ trials: collapsed("login") }), { maxRegressions: 0 });
    // Then the gate reports what the arithmetic says, and says nothing about criticality at all
    expect(g.decision).toBe("pass");
    expect(g.evidence.criticalFailures).toBeUndefined();
  });

  it("the same collapse BLOCKS once the policy declares the case critical — regardless of significance", () => {
    // Given the same comparison
    // When the candidate's verdict policy names the case critical
    const g = evaluateGate(base({ trials: collapsed("login"), criticalCases: [{ caseId: "login" }] }), {
      maxRegressions: 0,
    });
    // Then the block stands on the product judgment, and the reason says so with the p it overrode
    expect(g.decision).toBe("block");
    const reason = g.reasons.find((r) => r.kind === "critical_case_failed");
    expect(reason?.caseId).toBe("login");
    expect(reason?.detail).toContain("regardless of statistical significance");
    expect(g.evidence.criticalFailures).toBe(1);
  });

  it("a prefix matcher covers a whole family without listing every case", () => {
    const g = evaluateGate(base({ trials: collapsed("auth/login-otp"), criticalCases: [{ prefix: "auth/" }] }), {
      maxRegressions: 0,
    });
    expect(g.decision).toBe("block");
    expect(g.reasons[0]?.caseId).toBe("auth/login-otp");
  });

  it("a critical case missing from the candidate blocks even under a generous allow_partial tolerance", () => {
    // Given a caller that deliberately accepted losing up to 90% of the suite
    // When one of the cases the candidate never ran is a critical one
    const g = evaluateGate(
      base({
        comparability: "partial",
        missing: {
          casesOnlyInBaseline: ["checkout", "login"],
          casesOnlyInCandidate: [],
          metricsOnlyInBaseline: [],
          metricsOnlyInCandidate: [],
        },
        overlap: { sharedCases: 8, baselineCases: 10, candidateCases: 8 },
        criticalCases: [{ caseId: "login" }],
      }),
      { maxRegressions: 0, comparability: "allow_partial", maxMissingCases: 50, maxMissingFraction: 0.9 },
    );
    // Then the tolerance does not reach it: "we accept losing some coverage" was never an acceptance of this
    expect(g.decision).toBe("block");
    expect(g.reasons[0]).toMatchObject({ kind: "critical_case_failed", caseId: "login" });
    expect(g.reasons[0]?.detail).toContain("missing from the candidate");
    expect(g.evidence.criticalFailures).toBe(1);
  });

  it("on a NON-trial batch a critical case's pass → fail flip blocks regardless of the regression budget", () => {
    // Given a regression budget generous enough to absorb the flip
    const g = evaluateGate(
      base({
        regressions: [
          { caseId: "login", metric: "tests_pass", baseline: 1, candidate: 0, delta: -1, passChange: "broke" },
        ],
        caseTransitions: [{ caseId: "login", baseline: true, candidate: false, change: "broke" }],
        criticalCases: [{ caseId: "login" }],
      }),
      { maxRegressions: 5 },
    );
    // Then the budget does not cover a case the policy declared critical
    expect(g.decision).toBe("block");
    expect(g.reasons.map((r) => r.kind)).toContain("critical_case_failed");
  });

  it("a critical case that merely dipped is not a critical failure — the collapse is what the rule names", () => {
    const dipped = collapsed("login");
    const [only] = dipped.cases;
    if (!only) throw new Error("fixture");
    const g = evaluateGate(
      base({
        trials: { ...dipped, cases: [{ ...only, candidateRate: 1 / 3, delta: -2 / 3 }] },
        criticalCases: [{ caseId: "login" }],
      }),
      { maxRegressions: 0 },
    );
    expect(g.decision).toBe("pass");
    expect(g.evidence.criticalFailures).toBe(0);
  });

  it("a critical failure outranks blocked_missing — the decision is a block, with both reasons kept", () => {
    const g = evaluateGate(
      base({
        comparability: "partial",
        trials: collapsed("login"),
        missing: {
          casesOnlyInBaseline: ["gone"],
          casesOnlyInCandidate: [],
          metricsOnlyInBaseline: [],
          metricsOnlyInCandidate: [],
        },
        overlap: { sharedCases: 9, baselineCases: 10, candidateCases: 9 },
        criticalCases: [{ caseId: "login" }],
      }),
      { maxRegressions: 0 },
    );
    expect(g.decision).toBe("block");
    // The decision changes; the evidence never shrinks — the missingness reason still rides.
    expect(g.reasons.map((r) => r.kind)).toEqual(["critical_case_failed", "missing_cases"]);
  });
});

describe("evaluateGate — multiple-comparison correction evidence", () => {
  const withTrials = (over: Partial<NonNullable<GateInput["trials"]>>): GateInput =>
    base({
      trials: {
        baseline: "b",
        candidate: "c",
        zThreshold: 1.96,
        minDelta: 0,
        cases: [],
        regressions: [],
        improvements: [],
        missing: { casesOnlyInBaseline: [], casesOnlyInCandidate: [], unscoredCases: [] },
        ...over,
      },
    });

  it("counts the regressions the correction withdrew, so a pass can explain itself", () => {
    const g = evaluateGate(
      withTrials({
        fdrAlpha: 0.05,
        cases: [
          {
            caseId: "a",
            baselineRate: 1,
            baselineTrials: 20,
            candidateRate: 0.7,
            candidateTrials: 20,
            delta: -0.3,
            z: -2.3,
            method: "fisher",
            p: 0.02,
            significant: false,
            fdrSuppressed: true,
          },
        ],
      }),
      { maxRegressions: 0 },
    );
    expect(g.decision).toBe("pass");
    expect(g.evidence.suppressedByFdr).toBe(1);
  });

  it("reports no suppression count at all when no correction ran — absence is not zero", () => {
    const g = evaluateGate(withTrials({}), { maxRegressions: 0 });
    expect(g.evidence.suppressedByFdr).toBeUndefined();
  });
});

// C10 (review §6/§7): a metric "present on both sides" can survive on one row — rows a grader silently never
// emitted are in nobody's denominator, and 99 vanished measurements out of 100 must not read as green.
describe("evaluateGate — per-metric coverage loss (silent grader omission)", () => {
  const lostCoverage = (over: Partial<GateInput> = {}): GateInput =>
    base({
      comparability: "partial",
      metricCoverage: [
        { metric: "tests_pass", baselineCases: 100, baselineMeasured: 100, candidateCases: 100, candidateMeasured: 1 },
        {
          metric: "judge:quality",
          baselineCases: 100,
          baselineMeasured: 100,
          candidateCases: 100,
          candidateMeasured: 100,
        },
      ],
      overlap: { sharedCases: 100, baselineCases: 100, candidateCases: 100 },
      ...over,
    });

  it("a require_full gate blocks a 100/100 → 1/100 metric — zero regressions among the surviving rows is not a green light", () => {
    const g = evaluateGate(lostCoverage(), { maxRegressions: 0 });
    expect(g.decision).toBe("blocked_missing");
    const reason = g.reasons.find((r) => r.kind === "missing_metrics");
    expect(reason?.detail).toContain("tests_pass");
    expect(reason?.detail).toContain("100% → 1%");
  });

  it("allow_partial polices metric loss ONLY through its own stated limit — three losses, three knobs", () => {
    // Under a stated limit the 0.99 loss blocks …
    const strict = evaluateGate(lostCoverage(), {
      maxRegressions: 0,
      comparability: "allow_partial",
      maxMetricLossFraction: 0.5,
    });
    expect(strict.decision).toBe("blocked_missing");
    expect(strict.reasons.find((r) => r.kind === "missing_metrics")?.detail).toContain("maxMetricLossFraction");
    // … and with no limit stated, allow_partial means what it says (the caller accepted a subset).
    const lax = evaluateGate(lostCoverage(), { maxRegressions: 0, comparability: "allow_partial" });
    expect(lax.decision).toBe("pass");
  });

  it("complete disappearance is the MAXIMAL loss — maxMetricLossFraction 0 blocks a vanished metric", () => {
    // The escape hatch this closes: candidate 0/10 rows fell into metricsOnlyInBaseline — which allow_partial
    // never reads — so the STRICTEST loss setting passed total disappearance while blocking a one-row loss.
    const vanished = base({
      comparability: "partial",
      metricCoverage: [
        { metric: "tests_pass", baselineCases: 10, baselineMeasured: 10, candidateCases: 10, candidateMeasured: 0 },
        { metric: "judge:quality", baselineCases: 10, baselineMeasured: 10, candidateCases: 10, candidateMeasured: 10 },
      ],
      missing: {
        casesOnlyInBaseline: [],
        casesOnlyInCandidate: [],
        metricsOnlyInBaseline: ["tests_pass"],
        metricsOnlyInCandidate: [],
      },
      overlap: { sharedCases: 10, baselineCases: 10, candidateCases: 10 },
    });
    const g = evaluateGate(vanished, { maxRegressions: 0, comparability: "allow_partial", maxMetricLossFraction: 0 });
    expect(g.decision).toBe("blocked_missing");
    const reason = g.reasons.find((r) => r.kind === "missing_metrics");
    expect(reason?.detail).toContain("tests_pass");
    expect(reason?.detail).toContain("100.0% lost");
  });

  it("a kind-changed column blocks under allow_partial unless the caller accepts it explicitly", () => {
    // Loss knobs bound HOW MUCH may be missing; a kind change is a column that is present and means something
    // else — not a tolerance question, so allow_partial alone does not wave it through.
    const kindChanged = base({
      comparability: "partial",
      incomparable: [{ metric: "quality_tier", reason: "kind_changed" }],
    });
    const blocked = evaluateGate(kindChanged, { maxRegressions: 0, comparability: "allow_partial" });
    expect(blocked.decision).toBe("blocked_missing");
    expect(blocked.reasons.some((r) => r.kind === "kind_changed" && r.count === 1)).toBe(true);
    const accepted = evaluateGate(kindChanged, {
      maxRegressions: 0,
      comparability: "allow_partial",
      allowMetricKindChange: true,
    });
    expect(accepted.decision).toBe("pass");
  });

  it("full symmetric coverage never trips the gate — the check bites only on loss", () => {
    const g = evaluateGate(
      base({
        metricCoverage: [
          { metric: "tests_pass", baselineCases: 10, baselineMeasured: 10, candidateCases: 10, candidateMeasured: 10 },
        ],
      }),
      { maxRegressions: 0 },
    );
    expect(g.decision).toBe("pass");
  });
});

// ── RECORDED DOUBT IS ENFORCED DOUBT (arch-review 47 P0-3) ───────────────────────────────────────────
describe("applyInputTrust — the pins' input observation is a judgment condition, not an attachment", () => {
  const passEvaluation = (): GateEvaluation => ({
    decision: "pass",
    reasons: [],
    evidence: { comparability: "full" } as GateEvaluation["evidence"],
  });
  const pin = (inputObservation?: { completed: boolean; diverged?: number }): GateScoringPin =>
    ({
      revision: 1,
      scorePlaneDigest: "sha256:x",
      // Judgment provenance is RECORDED on these fixtures (arch-review 53, Wave D): this block is about the
      // input half of trust, and a pin that also said nothing about its author would be refused for the
      // other reason — testing one condition through a fixture that trips a second one certifies neither.
      judgmentProvenance: {
        kind: "recorded" as const,
        digest: "sha256:judgments",
        expectedUnits: 1,
        recordedUnits: 1,
        complete: true,
      },
      ...(inputObservation ? { inputObservation } : {}),
    }) as GateScoringPin;

  it("a COMPLETED divergence downgrades the decision to not_comparable — no policy waives a known-wrong subject", () => {
    const out = applyInputTrust(
      passEvaluation(),
      { candidate: pin({ completed: true, diverged: 2 }) },
      { maxRegressions: 0, allowUnverifiedInput: true }, // even the waiver does not cover divergence
    );
    expect(out.decision).toBe("not_comparable");
    expect(out.reasons[0]).toMatchObject({ kind: "input_diverged", count: 2 });
  });

  it("an UNVERIFIED input (ingest, ledger outage) refuses by default and passes only under the recorded waiver", () => {
    const unverified = { candidate: pin({ completed: false }) };
    const blocked = applyInputTrust(passEvaluation(), unverified, { maxRegressions: 0 });
    expect(blocked.decision).toBe("not_comparable");
    expect(blocked.reasons[0]).toMatchObject({ kind: "input_unverified" });
    const waived = applyInputTrust(passEvaluation(), unverified, { maxRegressions: 0, allowUnverifiedInput: true });
    expect(waived.decision).toBe("pass"); // the waiver is a recorded policy choice, visible on the decision
  });

  it("the BASELINE side is held to the same condition — a comparison is only as vouched as its weaker half", () => {
    const out = applyInputTrust(
      passEvaluation(),
      { baseline: pin({ completed: true, diverged: 1 }) },
      { maxRegressions: 0 },
    );
    expect(out.decision).toBe("not_comparable");
  });

  it("a LEGACY pin refuses by default too — receipt-vouched input only (owner decision); the waiver covers it", () => {
    const legacy = { baseline: pin(), candidate: pin() };
    const blocked = applyInputTrust(passEvaluation(), legacy, { maxRegressions: 0 });
    expect(blocked.decision).toBe("not_comparable");
    expect(blocked.reasons[0]).toMatchObject({ kind: "input_unverified" });
    expect(blocked.reasons[0]?.detail).toContain("predates input observation");
    const waived = applyInputTrust(passEvaluation(), legacy, { maxRegressions: 0, allowUnverifiedInput: true });
    expect(waived.decision).toBe("pass"); // gating over history is a recorded choice, never a default
  });

  it("the downgrade STRIPS the verdict-derived numbers — a refused input's regressions must not survive as evidence", () => {
    // Pre-fix the downgrade spread the computed evaluation whole: the decision said "no authority" while the
    // persisted evidence still said "7 regressions" — numbers an operator or issue automation would act on.
    const computed: GateEvaluation = {
      decision: "block",
      reasons: [{ kind: "regression", detail: "7 over the shared cases" }],
      evidence: {
        comparability: "full",
        regressions: 7,
        improvements: 2,
        criticalFailures: 1,
        suppressedByFdr: 1,
        missingCases: 0,
        trialsGated: false,
      },
    };
    const out = applyInputTrust(computed, { candidate: pin({ completed: false }) }, { maxRegressions: 0 });
    expect(out.decision).toBe("not_comparable");
    expect(out.evidence.regressions).toBeUndefined();
    expect(out.evidence.improvements).toBeUndefined();
    expect(out.evidence.criticalFailures).toBeUndefined();
    expect(out.evidence.suppressedByFdr).toBeUndefined();
    expect(out.evidence.comparability).toBe("full"); // structural facts survive — what was compared is not a verdict claim
  });
});

// ── TRUST IS A PRECONDITION, NOT A POST-PROCESSOR (arch-review 51 P1) ────────────────────────────────
describe("refuseGateForInputTrust — the pre-arithmetic refusal", () => {
  const pin = (inputObservation?: { completed: boolean; diverged?: number; cases?: number }): GateScoringPin =>
    ({
      revision: 1,
      scorePlaneDigest: "sha256:x",
      judgmentProvenance: {
        kind: "recorded" as const,
        digest: "sha256:judgments",
        expectedUnits: 1,
        recordedUnits: 1,
        complete: true,
      },
      ...(inputObservation ? { inputObservation } : {}),
    }) as GateScoringPin;

  it("an untrusted pin refuses BEFORE any diff exists — the evaluation carries no verdict-derived number at all", () => {
    const refusal = refuseGateForInputTrust({ candidate: pin({ completed: false }) }, { maxRegressions: 0 });
    expect(refusal?.decision).toBe("not_comparable");
    expect(refusal?.reasons[0]).toMatchObject({ kind: "input_unverified" });
    expect(refusal?.evidence.regressions).toBeUndefined();
    expect(refusal?.evidence.improvements).toBeUndefined();
    expect(refusal?.evidence.comparability).toBe("none"); // nothing was compared — the honest structural claim
  });

  it("vouched pins (or a recorded waiver) return undefined — the comparison may run", () => {
    const vouched = { baseline: pin({ completed: true, cases: 3 }), candidate: pin({ completed: true, cases: 3 }) };
    expect(refuseGateForInputTrust(vouched, { maxRegressions: 0 })).toBeUndefined();
    expect(
      refuseGateForInputTrust(
        { candidate: pin({ completed: false }) },
        { maxRegressions: 0, allowUnverifiedInput: true },
      ),
    ).toBeUndefined();
  });

  it("divergence refuses even under the waiver — same rule as the post-check, asked earlier", () => {
    const refusal = refuseGateForInputTrust(
      { candidate: pin({ completed: true, diverged: 1 }) },
      { maxRegressions: 0, allowUnverifiedInput: true },
    );
    expect(refusal?.decision).toBe("not_comparable");
    expect(refusal?.reasons[0]).toMatchObject({ kind: "input_diverged" });
  });
});
