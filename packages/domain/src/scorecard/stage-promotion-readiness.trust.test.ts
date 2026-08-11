import { describe, expect, it } from "vitest";
import { CURRENT_STAGE_PARITY_VERSION, stagePromotionReadiness } from "./stage-promotion.js";

// Trust suite (docs/trust-certification.md) — TRUST-124.
//
// A DEFERRAL WITH NO DECISION FUNCTION IS A DEFERRAL FOREVER.
//
// The scoring plane's contract step — promoting the write-ahead stage to the source of truth, after which a
// row of guards that exist only because reader and writer share one mutable carrier can be deleted — has
// been carried across five reviews with the same precondition: "observed real-traffic parity". That
// precondition lived in prose, so nobody could say whether it had been met, and a migration whose gate
// cannot be evaluated is one that never happens.
//
// It is now a function over the durable observations each settled pass records, and it inherits this suite's
// oldest rule rather than inventing a friendlier one: NOT EVALUATED IS NEVER GREEN.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const clean = (passId: string) => ({
  passId,
  stageParity: { version: CURRENT_STAGE_PARITY_VERSION, completed: true, promotionSafe: true },
});
const disagreed = (passId: string) => ({
  passId,
  stageParity: { version: CURRENT_STAGE_PARITY_VERSION, completed: true, promotionSafe: false },
});
const unmeasured = (passId: string) => ({
  passId,
  stageParity: {
    version: CURRENT_STAGE_PARITY_VERSION,
    completed: false,
    promotionSafe: false,
    failure: "stage read threw",
  },
});

// The same clean report, from an OLDER observer — the shape a pre-stamp deployment left behind.
const legacyClean = (passId: string) => ({ passId, stageParity: { completed: true, promotionSafe: true } });

describeTrust("TRUST-124 — the contract step is gated on evidence, not on somebody's reading of a dashboard", () => {
  it("enough clean observations is READY — the gate is passable, or it is theatre", () => {
    const readiness = stagePromotionReadiness([clean("p1"), clean("p2"), clean("p3")], 3);
    expect(readiness).toMatchObject({ observed: 3, safe: 3, incomplete: 0, ready: true });
  });

  it("a fleet that recorded NOTHING is not ready — zero mismatches over zero comparisons", () => {
    // The failure this whole field exists to prevent: a series that reads the same whether every pass agreed
    // or no pass was ever checked.
    const readiness = stagePromotionReadiness([{ passId: "p1" }, { passId: "p2" }], 2);
    expect(readiness).toMatchObject({ observed: 0, unobserved: 2, ready: false });
  });

  it("ONE comparison that could not run blocks, however many agreed", () => {
    const readiness = stagePromotionReadiness([clean("p1"), clean("p2"), unmeasured("p3")], 2);
    expect(readiness.ready).toBe(false);
    expect(readiness.incomplete).toBe(1);
    expect(readiness.blockedBy[0]).toMatchObject({ passId: "p3", reason: "stage read threw" });
  });

  it("a disagreeing pass blocks and is NAMED — a promotion decision must be traceable to what stops it", () => {
    const readiness = stagePromotionReadiness([clean("p1"), disagreed("p2")], 2);
    expect(readiness.ready).toBe(false);
    expect(readiness.blockedBy.map((b) => b.passId)).toEqual(["p2"]);
  });

  it("a legacy `promotionSafe: true` is NOT current evidence — the observer changed meaning five times", () => {
    // Evidence is only meaningful together with the decision procedure that produced it. The parity
    // comparison moved from stage-sourced to settled-plane expectation, from per-case to per-judge units,
    // and from JSON.stringify to canonical equality — a green from any of those is a green about a different
    // question, and the contract step must not be able to consume it.
    const readiness = stagePromotionReadiness([legacyClean("p1"), legacyClean("p2"), legacyClean("p3")], 3);
    expect(readiness).toMatchObject({ observed: 0, unobserved: 3, ready: false });
  });

  it("…and mixing eras does not top up the denominator", () => {
    const readiness = stagePromotionReadiness([clean("p1"), legacyClean("p2"), legacyClean("p3")], 3);
    expect(readiness).toMatchObject({ observed: 1, unobserved: 2, ready: false });
  });

  it("a minimum of zero is not a shortcut — an unevidenced promotion stays refused", () => {
    expect(stagePromotionReadiness([], 0).ready).toBe(false);
  });
});
