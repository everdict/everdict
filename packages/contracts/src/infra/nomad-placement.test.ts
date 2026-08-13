import { describe, expect, it } from "vitest";
import { describeNomadPlacementFailure } from "./nomad-placement.js";

// The scheduler's own verdict, in the two shapes that mean opposite things to a waiter.
describe("describeNomadPlacementFailure — why nothing was placed, in the scheduler's own words", () => {
  it("names a constraint filter — the reason a waiter would otherwise report as a bare timeout", () => {
    const failure = describeNomadPlacementFailure({
      browser: {
        NodesEvaluated: 3,
        ConstraintFiltered: { 'missing drivers "docker"': 3 },
        DimensionExhausted: {},
      },
    });
    expect(failure).toContain('filtered by constraint "missing drivers');
    expect(failure).toContain("3 node(s) evaluated");
  });

  it("names exhausted dimensions", () => {
    const failure = describeNomadPlacementFailure({
      api: { NodesEvaluated: 4, NodesExhausted: 4, DimensionExhausted: { memory: 4, cpu: 1 } },
    });
    expect(failure).toContain("memory exhausted on 4 node(s)");
    expect(failure).toContain("cpu exhausted on 1 node(s)");
  });

  it("reports a quota and a class exhaustion too — every reason the scheduler records", () => {
    const failure = describeNomadPlacementFailure({
      worker: { ClassExhausted: { gpu: 2 }, QuotaExhausted: ["team-a"], NodesEvaluated: 2 },
    });
    expect(failure).toContain('class "gpu" exhausted on 2 node(s)');
    expect(failure).toContain('quota "team-a" exhausted');
  });

  it("an evaluation with nothing failed is not a failure, and an empty cluster says so", () => {
    expect(describeNomadPlacementFailure(undefined)).toBeUndefined();
    expect(describeNomadPlacementFailure({})).toBeUndefined();
    // Nothing evaluated at all: no reason recorded, which is itself the news.
    expect(describeNomadPlacementFailure({ api: { NodesEvaluated: 0 } })).toContain("no eligible node");
  });
});
