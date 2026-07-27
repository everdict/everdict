import type { CaseResult, TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { billingCharges, billingTenant, costOf } from "./cost.js";

// A completed case whose trace carries one llm_call per (model, cost) entry, plus optional execution provenance.
function result(
  calls: Array<{ model: string; usd: number; tokens: number }>,
  provenance?: CaseResult["provenance"],
): CaseResult {
  const trace: TraceEvent[] = calls.map((c) => ({
    t: 0,
    kind: "llm_call",
    model: c.model,
    cost: { usd: c.usd, inputTokens: c.tokens, outputTokens: 0 },
  }));
  return {
    caseId: "c1",
    harness: "h@1",
    trace,
    snapshot: { kind: "prompt", output: "" },
    scores: [],
    ...(provenance ? { provenance } : {}),
  };
}

describe("billingTenant", () => {
  it("bills the original tenant for a managed run (no provenance)", () => {
    expect(billingTenant(result([{ model: "m", usd: 0.1, tokens: 1 }]), "acme")).toBe("acme");
  });
  it("bills the runner-owning workspace for a workspace-shared self-hosted run", () => {
    const r = result([{ model: "m", usd: 0.1, tokens: 1 }], { ranOn: "self-hosted", by: "ws:acme" });
    expect(billingTenant(r, "other")).toBe("acme");
  });
  it("is undefined (own-pays) for a personal self-hosted run", () => {
    const r = result([{ model: "m", usd: 0.1, tokens: 1 }], { ranOn: "self-hosted", by: "u-alice" });
    expect(billingTenant(r, "acme")).toBeUndefined();
  });
});

describe("billingCharges", () => {
  it("bills a managed run's whole cost to the tenant, per model, counting one evaluation", () => {
    const charges = billingCharges(result([{ model: "opus", usd: 0.1, tokens: 100 }]), "acme");
    expect(charges).toEqual([
      { tenant: "acme", source: "harness", model: "opus", cost: { usd: 0.1, tokens: 100 }, evaluations: 1 },
    ]);
  });

  it("splits cost per model and counts the evaluation exactly once (on the first line)", () => {
    const charges = billingCharges(
      result([
        { model: "opus", usd: 0.1, tokens: 100 },
        { model: "haiku", usd: 0.02, tokens: 40 },
      ]),
      "acme",
    );
    expect(charges).toHaveLength(2);
    expect(charges.reduce((n, c) => n + c.evaluations, 0)).toBe(1); // one case = one metered evaluation
    expect(charges.find((c) => c.model === "opus")?.cost).toEqual({ usd: 0.1, tokens: 100 });
    expect(charges.find((c) => c.model === "haiku")?.cost).toEqual({ usd: 0.02, tokens: 40 });
  });

  it("still counts one evaluation for a managed run with an empty/$0 trace", () => {
    const charges = billingCharges(result([]), "acme");
    expect(charges).toEqual([
      { tenant: "acme", source: "harness", model: "", cost: { usd: 0, tokens: 0 }, evaluations: 1 },
    ]);
  });

  it("does NOT bill a personal self-hosted run that used no workspace model (own-pays)", () => {
    const r = result([{ model: "opus", usd: 0.1, tokens: 100 }], { ranOn: "self-hosted", by: "u-alice" });
    expect(billingCharges(r, "acme")).toEqual([]);
  });

  it("bills the workspace for a personal self-hosted call on a workspace-billed model", () => {
    const r = result([{ model: "opus", usd: 0.1, tokens: 100 }], {
      ranOn: "self-hosted",
      by: "u-alice",
      billedModels: [{ id: "team-opus", model: "opus" }],
    });
    expect(billingCharges(r, "acme")).toEqual([
      { tenant: "acme", source: "harness", model: "opus", cost: { usd: 0.1, tokens: 100 }, evaluations: 1 },
    ]);
  });

  it("bills only the workspace-billed model's slice on a mixed own-pays run", () => {
    const r = result(
      [
        { model: "opus", usd: 0.1, tokens: 100 }, // workspace key
        { model: "local-llama", usd: 0.05, tokens: 50 }, // user's own login
      ],
      { ranOn: "self-hosted", by: "u-alice", billedModels: [{ id: "team-opus", model: "opus" }] },
    );
    const charges = billingCharges(r, "acme");
    expect(charges).toEqual([
      { tenant: "acme", source: "harness", model: "opus", cost: { usd: 0.1, tokens: 100 }, evaluations: 1 },
    ]);
  });

  it("bills a workspace-shared runner's whole cost to the runner-owning workspace", () => {
    const r = result([{ model: "opus", usd: 0.2, tokens: 200 }], { ranOn: "self-hosted", by: "ws:acme" });
    const charges = billingCharges(r, "other");
    expect(charges).toEqual([
      { tenant: "acme", source: "harness", model: "opus", cost: { usd: 0.2, tokens: 200 }, evaluations: 1 },
    ]);
  });

  it("sums to costOf for a fully-billed (managed) run", () => {
    const r = result([
      { model: "opus", usd: 0.1, tokens: 100 },
      { model: "haiku", usd: 0.02, tokens: 40 },
    ]);
    const total = billingCharges(r, "acme").reduce(
      (s, c) => ({ usd: s.usd + c.cost.usd, tokens: s.tokens + c.cost.tokens }),
      {
        usd: 0,
        tokens: 0,
      },
    );
    expect(total.usd).toBeCloseTo(costOf(r).usd, 10);
    expect(total.tokens).toBe(costOf(r).tokens);
  });
});
