import type { CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { decisionPassRate, headlinePassRate, preferredMetric } from "./headline.js";
import { summarizeScorecard, verdictSummaryOf } from "./scorecard.js";
import { composeVerdictPolicy, verdictPolicyRef } from "./verdict-policy.js";

describe("headlinePassRate", () => {
  it("a real judge:<id> pass rate outranks an arbitrary metric (dead-name family regression)", () => {
    // Before the fix only the literal "judge" had judge rank — judge:<id> fell to the anything-goes
    // fallback, tying it with (and losable to) any unranked pass-bearing metric appearing earlier.
    const rate = headlinePassRate({
      summary: [
        { metric: "custom_check", count: 4, mean: 0.25, passRate: 0.25 },
        { metric: "judge:quality", count: 4, mean: 0.75, passRate: 0.75 },
      ],
    });
    expect(rate).toBe(0.75);
  });

  it("preferredMetric picks the highest-authority pass-rate metric present in the SET — never a literal default", () => {
    // A workspace whose graders emit only judge:<id> got a silently empty board under metric="tests_pass".
    const cards = [
      { summary: [{ metric: "cost_usd", count: 3, mean: 0.4 }] },
      { summary: [{ metric: "judge:quality", count: 3, mean: 0.7, passRate: 0.7 }] },
    ];
    expect(preferredMetric(cards)).toBe("judge:quality");
    // ...and ground truth outranks the judge when both exist somewhere in the set
    const withTests = [...cards, { summary: [{ metric: "tests_pass", count: 3, mean: 1, passRate: 1 }] }];
    expect(preferredMetric(withTests)).toBe("tests_pass");
    // nothing pass-deciding: the first metric present, and an empty set resolves to nothing
    expect(preferredMetric([{ summary: [{ metric: "cost_usd", count: 3, mean: 0.4 }] }])).toBe("cost_usd");
    expect(preferredMetric([])).toBeUndefined();
  });

  it("a judge criterion metric (judge:<id>:<criterion>) never becomes the headline", () => {
    const rate = headlinePassRate({
      summary: [
        { metric: "judge:quality:helpfulness", count: 4, mean: 0.5, passRate: 0.5 },
        { metric: "judge:quality", count: 4, mean: 1, passRate: 1 },
      ],
    });
    expect(rate).toBe(1);
  });
});

describe("verdictSummaryOf / decisionPassRate — the stamped policy's own aggregate (arch-review 7 §4)", () => {
  const scored = (pass: boolean): CaseResult => ({
    caseId: `c-${Math.abs(Number(pass))}`,
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "done" },
    scores: [
      // The composed policy declares this metric GROUND TRUTH — it decides the case…
      { graderId: "biz", metric: "custom_business_state", value: pass ? 1 : 0, pass },
      // …while the judge disagrees, and the judge is the highest rung the headline LADDER can see.
      { graderId: "quality", metric: "judge:quality", value: pass ? 0 : 1, pass: !pass },
    ],
  });

  it("a composed ground_truth metric decides the aggregate even though the headline ladder cannot see it", () => {
    const composed = composeVerdictPolicy([{ id: "custom_business_state", authority: "ground_truth" }]);
    const results = [scored(true), scored(true)];
    // The headline ranks judge:quality (its ladder knows nothing of the custom metric) — and reads 0%.
    expect(headlinePassRate({ summary: summarizeScorecard({ suiteId: "s", harness: "h@1", results }) })).toBe(0);
    // The persisted aggregate follows caseVerdict under the batch's OWN policy — 100%, digest-stamped.
    const vs = verdictSummaryOf(results, composed);
    expect(vs).toMatchObject({ verdicted: 2, passed: 2, failed: 0, passRate: 1 });
    expect(vs.policyDigest).toBe(verdictPolicyRef(composed).digest);
    // Decision surfaces read the aggregate first; the headline stays the legacy fallback.
    expect(decisionPassRate({ verdictSummary: vs })).toBe(1);
    expect(decisionPassRate({ summary: summarizeScorecard({ suiteId: "s", harness: "h@1", results }) })).toBe(0);
  });

  it("nothing verdicted is ABSENCE — and a decision surface treats it as the answer, never falling through", () => {
    const vs = verdictSummaryOf([], undefined);
    expect(vs).toMatchObject({ verdicted: 0, passed: 0, failed: 0 });
    expect(vs.passRate).toBeUndefined(); // a rate over nothing is absence, never 0
    // A record carrying the aggregate does NOT fall through to a metric-level rate the policy might rank
    // differently — absence is the aggregate's real answer.
    expect(
      decisionPassRate({ verdictSummary: vs, summary: [{ metric: "tests_pass", count: 2, passRate: 1 }] }),
    ).toBeNull();
  });
});
