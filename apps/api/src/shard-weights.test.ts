import { describe, expect, it } from "vitest";
import { weightedTargets } from "./shard-weights.js";

describe("weightedTargets — history-informed shard split", () => {
  it("no history → the old uniform round-robin, verbatim", () => {
    expect(weightedTargets(5, ["a", "b"], new Map())).toEqual(["a", "b", "a", "b", "a"]);
    expect(weightedTargets(3, ["only"], new Map([["only", 10]]))).toEqual(["only", "only", "only"]);
  });

  it("a 3×-faster runtime takes ~3× the cases, smoothly interleaved (no long same-target runs)", () => {
    const medians = new Map([
      ["fast", 10],
      ["slow", 30],
    ]);
    const assigned = weightedTargets(12, ["slow", "fast"], medians);
    const fast = assigned.filter((t) => t === "fast").length;
    expect(fast).toBe(9); // weights 1/10 : 1/30 = 3 : 1 → 9 vs 3
    // Smooth: the slow target never disappears for more than its proportional gap.
    let maxRun = 0;
    let run = 0;
    for (const t of assigned) {
      run = t === "fast" ? run + 1 : 0;
      maxRun = Math.max(maxRun, run);
    }
    expect(maxRun).toBeLessThanOrEqual(4);
  });

  it("a target with no history gets the AVERAGE weight (unknown ≠ slow)", () => {
    const medians = new Map([["known", 10]]); // the other target has no samples
    const assigned = weightedTargets(10, ["known", "mystery"], medians);
    const known = assigned.filter((t) => t === "known").length;
    expect(known).toBe(5); // average weight = the known one's weight → even split
  });

  it("deterministic for identical inputs (re-plans reproduce the same split)", () => {
    const medians = new Map([
      ["a", 12],
      ["b", 7],
      ["c", 20],
    ]);
    const one = weightedTargets(50, ["a", "b", "c"], medians);
    const two = weightedTargets(50, ["a", "b", "c"], medians);
    expect(one).toEqual(two);
  });
});
