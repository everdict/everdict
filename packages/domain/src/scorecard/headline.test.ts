import { describe, expect, it } from "vitest";
import { headlinePassRate } from "./headline.js";

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
