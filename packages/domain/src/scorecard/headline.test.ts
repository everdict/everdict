import { describe, expect, it } from "vitest";
import { headlinePassRate, preferredMetric } from "./headline.js";

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
