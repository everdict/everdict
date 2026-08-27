import type { CampaignFrame, CampaignRound } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { campaignAdoption } from "./campaign-gate.js";

// ── THE ADOPTION GATE IS CODE, NOT PROSE (docs/architecture/evolution-lineage.md, Track D) ───────────
//
// Everything the agent-evolve skill mandates in prose — adopt only on significant-improvement-with-zero-
// regressions, stop after consecutive rejected rounds, a budget stated up front and honored, never adopt
// over an unverifiable world — becomes one total function over the frozen frame and the append-only rounds.
// No mutable counters: the streak and the spend are DERIVED from the rounds, so the answer cannot disagree
// with the trace that produced it.
//
// RED before the gate existed: Cannot find module './campaign-gate.js'.

const frame = (over: Partial<CampaignFrame> = {}): CampaignFrame => ({
  subject: { type: "agent", id: "everdict", baselineVersion: "1.0.0" },
  scenarios: [
    { id: "s1", heldOut: false },
    { id: "s2", heldOut: true },
  ],
  judges: ["drill-structure"],
  trialsPerCase: 5,
  budget: { maxRounds: 10 },
  stopAfterRejectedRounds: 3,
  significance: {},
  allowUnverifiedIdentity: false,
  allowLabelOnlyAdoption: false,
  observationPolicy: { allowDivergent: false },
  ...over,
});

let seq = 0;
const round = (
  verdict: Partial<CampaignRound["verdict"]>,
  over: Partial<Omit<CampaignRound, "verdict">> = {},
): CampaignRound => {
  seq += 1;
  return {
    seq,
    hypothesis: "structure over phrasing",
    candidateVersion: `1.0.${seq}`,
    baselineScorecardId: "sc-base",
    candidateScorecardId: `sc-cand-${seq}`,
    verdict: ((): CampaignRound["verdict"] => {
      const v = {
        comparable: true,
        significantImprovements: 0,
        significantRegressions: 0,
        unverifiedAxes: [],
        confoundedAxes: [],
        // ── …AND THE BYTES, FOR THE SAME REASON AS THE HELD-OUT BLOCK BELOW (arch-review 73) ────────
        //
        // A real round's candidate scorecard seals a manifest. Leaving it out made every case here run the
        // label-only path, so tightening that path turned nine tests about the waiver / the streak / the
        // budget into failures about byte identity — the fixture had drifted onto the weaker branch, which
        // is the same defect class as the code it was testing.
        candidateSpecDigest: `sha256:cand-${seq}`,
        ...verdict,
      };
      // ── HELD-OUT MIRRORS THE ROUND HERE, ON PURPOSE (arch-review 71 P1-high) ──────────────────────
      //
      // Adoption authority comes from the held-out population now, and these cases are about the gate's
      // OTHER axes — the recorded waiver, the rejection streak, the budget. Deriving the held-out block from
      // the counts they set keeps each of them testing its own axis instead of silently becoming a
      // held-out test. The separation itself is pinned in `held-out-authority.counterexample.test.ts`.
      return {
        ...v,
        heldOut: v.heldOut ?? {
          improvements: v.significantImprovements,
          regressions: v.significantRegressions,
        },
      };
    })(),
    at: "2026-08-26T00:00:00.000Z",
    by: "agent:everdict",
    ...over,
  };
};

describe("campaignAdoption — a total answer over the frame and the rounds", () => {
  it("an unstarted campaign continues with the whole budget", () => {
    seq = 0;
    expect(campaignAdoption(frame(), [])).toEqual({ kind: "continue", roundsLeft: 10, consecutiveRejected: 0 });
  });

  it("adopts the LATEST round's candidate on significant improvement with zero regressions", () => {
    seq = 0;
    const rounds = [round({}), round({ significantImprovements: 2 })];
    expect(campaignAdoption(frame(), rounds)).toEqual({
      kind: "adopt",
      version: "1.0.2",
      provingScorecardId: "sc-cand-2",
      waivedAxes: [],
      candidateSpecDigest: "sha256:cand-2",
    });
  });

  it("a single significant regression blocks adoption however many improvements ride beside it", () => {
    seq = 0;
    const rounds = [round({ significantImprovements: 3, significantRegressions: 1 })];
    expect(campaignAdoption(frame(), rounds).kind).not.toBe("adopt");
  });

  it("an EARLIER winning round does not adopt — only the latest candidate is on the table", () => {
    // Adoption is of the current candidate; a stale win followed by a worse attempt is a loop that should
    // return to the winning variant explicitly, not a gate doing archaeology.
    seq = 0;
    const rounds = [round({ significantImprovements: 1 }), round({})];
    expect(campaignAdoption(frame(), rounds).kind).toBe("continue");
  });

  it("refuses to adopt over an unverified world identity — the waiver must have been recorded at open", () => {
    seq = 0;
    const rounds = [round({ significantImprovements: 1, unverifiedAxes: ["execution_world"] })];
    const answer = campaignAdoption(frame(), rounds);
    expect(answer).toEqual({
      kind: "halt",
      reason: "identity_unverified",
      detail: expect.stringContaining("execution_world"),
    });
  });

  it("adopts over an unverified axis ONLY under the frame's recorded waiver, and says which axes were waived", () => {
    seq = 0;
    const rounds = [round({ significantImprovements: 1, unverifiedAxes: ["execution_world"] })];
    expect(campaignAdoption(frame({ allowUnverifiedIdentity: true }), rounds)).toEqual({
      kind: "adopt",
      version: "1.0.1",
      provingScorecardId: "sc-cand-1",
      candidateSpecDigest: "sha256:cand-1",
      waivedAxes: ["execution_world"],
    });
  });

  it("a non-comparable round is a rejected round, whatever counts it carries", () => {
    // A policy-mismatched or trial-less pair produced no significance signal; counts riding on it are not
    // evidence, and treating them as a win would let a broken comparison adopt.
    seq = 0;
    const rounds = [round({ comparable: false, significantImprovements: 5 })];
    expect(campaignAdoption(frame(), rounds).kind).toBe("continue");
  });

  it("halts as no_improvement after the frame's consecutive rejected rounds", () => {
    seq = 0;
    const rounds = [round({}), round({}), round({})];
    expect(campaignAdoption(frame(), rounds)).toMatchObject({ kind: "halt", reason: "no_improvement" });
  });

  it("a win resets the rejected streak — three rejections must be consecutive", () => {
    seq = 0;
    // rejected, rejected, WIN (not adopted — say identity blocked it? no: keep it simple, a comparable win
    // then two more rejections: streak is 2, not 4.
    const rounds = [round({}), round({}), round({ significantImprovements: 1 }), round({}), round({})];
    const answer = campaignAdoption(frame(), rounds);
    expect(answer).toEqual({ kind: "continue", roundsLeft: 5, consecutiveRejected: 2 });
  });

  it("halts as budget_exhausted when the rounds spend the frame's cap without an adoptable latest", () => {
    seq = 0;
    const rounds = [round({}), round({ significantImprovements: 1, significantRegressions: 1 })];
    expect(campaignAdoption(frame({ budget: { maxRounds: 2 } }), rounds)).toMatchObject({
      kind: "halt",
      reason: "budget_exhausted",
    });
  });

  it("the streak halt wins over the budget halt — the more specific reason names the problem", () => {
    seq = 0;
    const rounds = [round({}), round({}), round({})];
    expect(campaignAdoption(frame({ budget: { maxRounds: 3 } }), rounds)).toMatchObject({
      kind: "halt",
      reason: "no_improvement",
    });
  });
});
