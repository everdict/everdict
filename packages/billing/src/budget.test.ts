import type { CaseResult } from "@everdict/core";
import { PaymentRequiredError } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { inMemoryBudget } from "./budget.js";
import { billingTenant, sumCost } from "./cost.js";

describe("sumCost", () => {
  it("sums the trace's llm_call cost (usd/tokens)", () => {
    const c = sumCost([
      { t: 0, kind: "tool_call", id: "1", name: "x", args: {} },
      { t: 1, kind: "llm_call", model: "m", cost: { inputTokens: 10, outputTokens: 5, usd: 0.03 } },
      { t: 2, kind: "llm_call", model: "m", cost: { inputTokens: 20, outputTokens: 0, usd: 0.02 } },
    ]);
    expect(c.usd).toBeCloseTo(0.05);
    expect(c.tokens).toBe(35);
  });
});

describe("inMemoryBudget", () => {
  it("runs cap: admit reserves immediately, so even a burst can't exceed the cap", () => {
    const b = inMemoryBudget({ limitFor: () => ({ runs: 2 }) });
    b.admit("t");
    b.admit("t");
    expect(() => b.admit("t")).toThrow(PaymentRequiredError);
    expect(b.usage("t").runs).toBe(2);
  });

  it("usd cap: reject when already-committed cost is at or above the cap", () => {
    const b = inMemoryBudget({ limitFor: () => ({ usd: 0.1 }) });
    b.admit("t");
    b.settle("t", { usd: 0.1, tokens: 100 });
    expect(() => b.admit("t")).toThrow(PaymentRequiredError); // 0.1 >= 0.1
    expect(b.usage("t").usd).toBeCloseTo(0.1);
  });

  it("is independent per tenant (A's exhaustion doesn't affect B)", () => {
    const b = inMemoryBudget({ limitFor: () => ({ runs: 1 }) });
    b.admit("A");
    expect(() => b.admit("A")).toThrow();
    expect(() => b.admit("B")).not.toThrow(); // B is separate
  });

  it("counts runs even when unlimited", () => {
    const b = inMemoryBudget({ limitFor: () => undefined });
    b.admit("t");
    b.admit("t");
    expect(b.usage("t").runs).toBe(2);
  });

  it("release gives back a reserved run (a cancelled-before-run job restores headroom)", () => {
    const b = inMemoryBudget({ limitFor: () => ({ runs: 2 }) });
    b.admit("t");
    b.admit("t"); // runs = 2, at the cap
    expect(() => b.admit("t")).toThrow(PaymentRequiredError);
    b.release("t"); // one admitted job was cancelled before running
    expect(b.usage("t").runs).toBe(1);
    expect(() => b.admit("t")).not.toThrow(); // headroom restored
  });

  it("release floors at 0 (releasing more than was admitted can't underflow)", () => {
    const b = inMemoryBudget({ limitFor: () => undefined });
    b.release("t"); // never admitted
    expect(b.usage("t").runs).toBe(0);
  });
});

describe("billingTenant — which tenant's budget the cost goes on (provenance-based)", () => {
  const result = (provenance?: CaseResult["provenance"]): CaseResult => ({
    caseId: "c",
    harness: "h@0",
    trace: [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores: [],
    ...(provenance ? { provenance } : {}),
  });

  it("managed (no provenance): the job's original tenant pays", () => {
    expect(billingTenant(result(), "acme")).toBe("acme");
  });

  it("managed (ranOn≠self-hosted): the original tenant pays", () => {
    expect(billingTenant(result({ ranOn: "nomad" }), "acme")).toBe("acme");
  });

  it("workspace-shared runner (by=ws:<ws>): that workspace pays (a team resource)", () => {
    expect(billingTenant(result({ ranOn: "self-hosted", runner: "r1", by: "ws:acme" }), "acme")).toBe("acme");
    // If by came in for a different workspace, trust by (attribution = the runner's owning workspace)
    expect(billingTenant(result({ ranOn: "self-hosted", by: "ws:beta" }), "acme")).toBe("beta");
  });

  it("personal self-hosted runner (by=subject): own-pays → undefined (not drawn)", () => {
    expect(billingTenant(result({ ranOn: "self-hosted", runner: "r1", by: "u-alice" }), "acme")).toBeUndefined();
    // Missing by (legacy) is also treated as personal — own-pays
    expect(billingTenant(result({ ranOn: "self-hosted" }), "acme")).toBeUndefined();
  });
});
