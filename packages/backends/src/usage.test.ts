import type { CaseResult } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { inMemoryUsageMeter, totalUsage } from "./usage.js";

// A completed case with one llm_call carrying the given cost + optional execution provenance (for own-pays/ws-shared).
function result(usd: number, tokens: number, provenance?: CaseResult["provenance"]): CaseResult {
  return {
    caseId: "c1",
    harness: "h@1",
    trace: [{ t: 0, kind: "llm_call", model: "m", cost: { usd, inputTokens: tokens, outputTokens: 0 } }],
    snapshot: { kind: "prompt", output: "" },
    scores: [],
    ...(provenance ? { provenance } : {}),
  };
}

describe("inMemoryUsageMeter", () => {
  it("records cost by source and in the total; evaluations default to 0 for a judge score", () => {
    const meter = inMemoryUsageMeter();
    meter.record("acme", "judge", { usd: 0.02, tokens: 50 });
    const u = meter.usage("acme");
    expect(u).toMatchObject({ usd: 0.02, tokens: 50, evaluations: 0 });
    expect(u.bySource.judge).toMatchObject({ usd: 0.02, tokens: 50, evaluations: 0 });
    expect(u.bySource.harness).toMatchObject({ usd: 0, tokens: 0, evaluations: 0 });
  });

  it("meterCase records the harness LLM cost against the original tenant (managed) + one evaluation", () => {
    const meter = inMemoryUsageMeter();
    meter.meterCase(result(0.1, 100), "acme");
    const u = meter.usage("acme");
    expect(u).toMatchObject({ usd: 0.1, tokens: 100, evaluations: 1 });
    expect(u.bySource.harness).toMatchObject({ usd: 0.1, tokens: 100, evaluations: 1 });
  });

  it("does NOT meter an own-pays (personal self-hosted) run — the tenant paid their own login (BYO compute)", () => {
    const meter = inMemoryUsageMeter();
    meter.meterCase(result(0.1, 100, { ranOn: "self-hosted", by: "u-alice" }), "acme");
    expect(meter.usage("acme")).toMatchObject({ usd: 0, tokens: 0, evaluations: 0 });
  });

  it("attributes a workspace-shared runner's cost to the workspace (a team resource)", () => {
    const meter = inMemoryUsageMeter();
    meter.meterCase(result(0.2, 200, { ranOn: "self-hosted", by: "ws:acme" }), "acme");
    expect(meter.usage("acme")).toMatchObject({ usd: 0.2, tokens: 200, evaluations: 1 });
  });

  it("sums harness + judge into the total while keeping the per-source split", () => {
    const meter = inMemoryUsageMeter();
    meter.meterCase(result(0.1, 100), "acme");
    meter.record("acme", "judge", { usd: 0.03, tokens: 30 });
    const u = meter.usage("acme");
    expect(u).toMatchObject({ usd: 0.13, tokens: 130, evaluations: 1 });
    expect(u.bySource.harness).toMatchObject({ usd: 0.1, tokens: 100, evaluations: 1 });
    expect(u.bySource.judge).toMatchObject({ usd: 0.03, tokens: 30, evaluations: 0 });
  });

  it("usage() returns an isolated snapshot — mutating it does not corrupt the meter", () => {
    const meter = inMemoryUsageMeter();
    meter.record("acme", "harness", { usd: 1, tokens: 10 }, 1);
    const snapshot = meter.usage("acme");
    snapshot.usd = 999;
    snapshot.bySource.harness.usd = 999;
    expect(meter.usage("acme").usd).toBe(1);
    expect(meter.usage("acme").bySource.harness.usd).toBe(1);
  });
});

describe("totalUsage", () => {
  it("sums metered usage across tenants (operator rollup)", () => {
    const meter = inMemoryUsageMeter();
    meter.meterCase(result(0.1, 100), "acme");
    meter.meterCase(result(0.4, 400), "beta");
    expect(totalUsage(meter, ["acme", "beta"])).toEqual({ usd: 0.5, tokens: 500, evaluations: 2 });
  });
});
