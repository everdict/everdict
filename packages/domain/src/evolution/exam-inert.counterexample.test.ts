import type { CampaignFrame, CampaignRound } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { campaignAdoption, campaignStoppedAt } from "./campaign-gate.js";

// ── A DIFFERENTIAL CANNOT SEE A DEAD INSTRUMENT ──────────────────────────────────────────────────────
//
// The round verdict is deltas: `significantImprovements`, `significantRegressions`, and the held-out block.
// So these two campaigns are the SAME record:
//
//     both arms score 0.0 on every scenario   →  comparable: true · 0/0 · heldOut 0/0
//     both arms score 1.0 on every scenario   →  comparable: true · 0/0 · heldOut 0/0
//
// and both end `no_improvement`, which says the hypotheses failed. In the first one the hypotheses were
// never tested: a SpreadsheetBench wave ran round after round at 14.3% against a grader that had scored 420
// of the 912 published tasks zero without opening the agent's workbook, and one whose answer key was
// permuted — so a candidate that solved all three test workbooks was recorded as failing. Every refusal the
// gate made was correct, and the reason it gave was wrong.
//
// `response` is the absolute level the service already holds (`TrialCaseDelta` carries `baselineRate` and
// `candidateRate`) and used to discard. The gate reads it only to RENAME an ending it was already going to
// declare — the timing is untouched, so a mistaken inertness diagnosis can never end a campaign that would
// otherwise have continued.
//
// RED before the change, on the first case:
//   AssertionError: expected 'no_improvement' to be 'exam_inert'

const frame = (over: Partial<CampaignFrame> = {}): CampaignFrame => ({
  subject: { type: "agent", id: "everdict", baselineVersion: "1.0.0" },
  scenarios: [
    { id: "s1", heldOut: false },
    { id: "s2", heldOut: true },
    { id: "s3", heldOut: true },
  ],
  judges: [],
  trialsPerCase: 5,
  budget: { maxRounds: 10 },
  stopAfterRejectedRounds: 3,
  significance: { fdrAlpha: 0.05, heldOutFamilySize: 10 },
  allowUnverifiedIdentity: false,
  allowLabelOnlyAdoption: false,
  oracleScope: [],
  targets: [],
  observationPolicy: { allowDivergent: false },
  ...over,
});

let seq = 0;
const round = (response?: { solved: string[]; failed: string[]; scenarios: number }): CampaignRound => {
  seq += 1;
  return {
    seq,
    hypothesis: "a scaffold that names the sheet",
    informedBy: [],
    candidateVersion: `1.0.${seq}`,
    baselineScorecardId: "sc-base",
    candidateScorecardId: `sc-cand-${seq}`,
    learned: "the tool budget was not the binding constraint",
    verdict: {
      comparable: true,
      significantImprovements: 0,
      significantRegressions: 0,
      heldOut: { improvements: 0, regressions: 0 },
      unverifiedAxes: [],
      confoundedAxes: [],
      candidateSpecDigest: `sha256:cand-${seq}`,
      ...(response !== undefined ? { response } : {}),
    },
    at: "2026-09-05T00:00:00.000Z",
    by: "agent:everdict",
  };
};

const inert = () => round({ solved: [], failed: ["s1", "s2", "s3"], scenarios: 3 });
// A round the platform could not MEASURE: comparable: false, so it never reaches the level at all. It is
// the shape a broken grader produces now that an unscoreable case publishes no reward — the case falls
// below the frame's trial floor, the round is rejected as thin, and the rejection streak ends the campaign.
const unmeasured = (): CampaignRound => {
  seq += 1;
  return {
    seq,
    hypothesis: "a scaffold that names the sheet",
    informedBy: [],
    candidateVersion: `1.0.${seq}`,
    baselineScorecardId: "sc-base",
    candidateScorecardId: `sc-cand-${seq}`,
    learned: "the grader could not read three of the answer positions",
    verdict: {
      comparable: false,
      significantImprovements: 0,
      significantRegressions: 0,
      unverifiedAxes: [],
      confoundedAxes: [],
      unmeasured: { cases: 3, of: 3 },
      detail: "3 case(s) ran fewer than the frame's 5 trials",
    },
    at: "2026-09-05T00:00:00.000Z",
    by: "agent:everdict",
  };
};
const alive = () => round({ solved: ["s1"], failed: ["s2", "s3"], scenarios: 3 });
const ceiling = () => round({ solved: ["s1", "s2", "s3"], failed: [], scenarios: 3 });

describe("exam_inert — an ending that names the instrument, not the hypotheses", () => {
  it("three rejected rounds in which NOTHING was ever solved end as exam_inert, not no_improvement", () => {
    seq = 0;
    const answer = campaignAdoption(frame(), [inert(), inert(), inert()]);
    expect(answer.kind).toBe("halt");
    if (answer.kind !== "halt") return;
    expect(answer.reason).toBe("exam_inert");
    expect(answer.detail).toMatch(/never|no scenario/i);
  });

  it("…and the ending's TIMING is untouched — the same round, whatever the diagnosis", () => {
    seq = 0;
    const dead = campaignStoppedAt(frame(), [inert(), inert(), inert()]);
    seq = 0;
    const live = campaignStoppedAt(frame(), [alive(), alive(), alive()]);
    expect(dead?.atRound).toBe(3);
    expect(live?.atRound).toBe(3);
  });

  it("one round that solved something makes the exam responsive, and the ending is no_improvement again", () => {
    seq = 0;
    const answer = campaignAdoption(frame(), [inert(), alive(), inert()]);
    expect(answer.kind).toBe("halt");
    if (answer.kind !== "halt") return;
    expect(answer.reason).toBe("no_improvement");
  });

  it("an exam every arm passes completely is inert too — there is no headroom to measure", () => {
    seq = 0;
    const answer = campaignAdoption(frame(), [ceiling(), ceiling(), ceiling()]);
    expect(answer.kind).toBe("halt");
    if (answer.kind !== "halt") return;
    expect(answer.reason).toBe("exam_inert");
    expect(answer.detail).toMatch(/headroom|every scenario/i);
  });

  it("SILENCE IS NOT INERTNESS: rounds written before `response` existed keep the old ending", () => {
    // The fail-safe direction. A halt ends a campaign, so renaming one on absent evidence would let a
    // legacy trace be diagnosed as a broken exam it may never have had — L2's third value, at the one
    // place where guessing costs a campaign.
    seq = 0;
    const answer = campaignAdoption(frame(), [round(), round(), round()]);
    expect(answer.kind).toBe("halt");
    if (answer.kind !== "halt") return;
    expect(answer.reason).toBe("no_improvement");
  });

  it("a partly-legacy trace cannot conclude either — one round that cannot say is enough to withhold it", () => {
    seq = 0;
    const answer = campaignAdoption(frame(), [inert(), round(), inert()]);
    expect(answer.kind).toBe("halt");
    if (answer.kind !== "halt") return;
    expect(answer.reason).toBe("no_improvement");
  });

  it("rounds the platform could not MEASURE end as exam_inert, not as three failed hypotheses", () => {
    seq = 0;
    const answer = campaignAdoption(frame(), [unmeasured(), unmeasured(), unmeasured()]);
    expect(answer.kind).toBe("halt");
    if (answer.kind !== "halt") return;
    expect(answer.reason).toBe("exam_inert");
    expect(answer.detail).toMatch(/could not be measured|never measured/i);
  });

  it("a mix of measured-and-dead with could-not-measure withholds the diagnosis rather than guessing", () => {
    seq = 0;
    const answer = campaignAdoption(frame(), [inert(), unmeasured(), inert()]);
    expect(answer.kind).toBe("halt");
    if (answer.kind !== "halt") return;
    expect(answer.reason).toBe("no_improvement");
  });

  it("a spent budget over a dead exam names the exam, because that is what a next round would meet", () => {
    seq = 0;
    const f = frame({ budget: { maxRounds: 2 }, stopAfterRejectedRounds: 9 });
    const answer = campaignAdoption(f, [inert(), inert()]);
    expect(answer.kind).toBe("halt");
    if (answer.kind !== "halt") return;
    expect(answer.reason).toBe("exam_inert");
  });
});
