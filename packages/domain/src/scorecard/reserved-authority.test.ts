import { RESERVED_AUTHORITY_METRICS } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_VERDICT_POLICY } from "./verdict-policy.js";

// arch-review 17 P0-2. `RESERVED_AUTHORITY_METRICS` lives in contracts so the producer boundary can enforce it
// without reaching into the domain, and the LADDER is a frozen constitutional document here — it cannot be
// rebuilt from a list without changing the bytes its stamps resolve against. So the two are kept in step by
// assertion rather than by construction, exactly as `MAX_STALLED_SCORE_ROUNDS` is kept in step with the retry
// budget it must dominate: a derived constant nobody derives is a constant that drifts.
describe("reserved authority metrics == the ladder's own pass-deciding exact matchers", () => {
  it("is exactly the set of exact-metric names the default policy treats as ground_truth or objective", () => {
    const fromLadder = DEFAULT_VERDICT_POLICY.metrics
      .filter((m) => m.authority === "ground_truth" || m.authority === "objective")
      .map((m) => ("metric" in m.match ? m.match.metric : undefined))
      .filter((name): name is string => name !== undefined)
      .sort();
    expect([...RESERVED_AUTHORITY_METRICS].sort()).toEqual(fromLadder);
  });

  it("covers every pass-deciding exact matcher — a prefix rule would silently leave names unguarded", () => {
    // If the ladder ever grows a pass-deciding matcher expressed only as a PREFIX, this list cannot represent
    // it and the guard would have a hole nobody declared. Fail here instead, where it can be designed.
    const prefixDeciders = DEFAULT_VERDICT_POLICY.metrics.filter(
      (m) => (m.authority === "ground_truth" || m.authority === "objective") && !("metric" in m.match),
    );
    expect(prefixDeciders).toEqual([]);
  });
});
