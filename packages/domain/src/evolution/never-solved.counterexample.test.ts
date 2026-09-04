import type { CampaignFrame, CampaignRound } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { campaignAdoption } from "./campaign-gate.js";

// ── INERTNESS IS ALL-OR-NOTHING AND THE REAL FAILURE WAS A SUBSET ────────────────────────────────────
//
// `exam_inert` fires when NO scenario was ever solved. The wave that motivated it does not qualify: its best
// round read
//
//     31202:5/5   34033:4/5   38537:1/5   …and eleven cases at 0/5
//
// so `solved` was 3 and the diagnosis never triggers. Eleven of fourteen scenarios had never been passed by
// anything, several of them structurally unwinnable — a grader whose `answer_position` reader raised on
// their range, and one whose published answer key was permuted. That is the loudest signal the trace
// contains and an all-or-nothing predicate cannot see it.
//
// So the gate also answers WHICH scenarios have never been passed by either arm in any round. It is not a
// new ending: an exam that responds on three cases is not inert, and a campaign may legitimately improve
// those three. It is the sentence that points at the dataset, carried on `continue` as well as on the halt —
// on `continue` because a driver asks `decision` every round, and round 2 is when this was worth knowing.
//
// RED before the change:
//   AssertionError: expected { kind: 'continue', roundsLeft: 8, …(1) } to have property "neverSolved"

const frame = (over: Partial<CampaignFrame> = {}): CampaignFrame => ({
  subject: { type: "harness", id: "sbench", baselineVersion: "1.0.0" },
  scenarios: [
    { id: "s1", heldOut: false },
    { id: "s2", heldOut: true },
    { id: "s3", heldOut: true },
    { id: "s4", heldOut: true },
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

describe("neverSolved — the scenarios nothing has ever passed", () => {
  it("names them while the campaign is still RUNNING, which is when it is worth knowing", () => {
    seq = 0;
    const answer = campaignAdoption(frame(), [
      round({ solved: ["s1"], failed: ["s2", "s3", "s4"], scenarios: 4 }),
      round({ solved: ["s2"], failed: ["s1", "s3", "s4"], scenarios: 4 }),
    ]);
    expect(answer.kind).toBe("continue");
    expect(answer.neverSolved).toEqual(["s3", "s4"]);
  });

  it("a scenario solved in ANY round is not never-solved — the union across the walk, not the latest round", () => {
    seq = 0;
    const answer = campaignAdoption(frame(), [
      round({ solved: ["s1", "s2", "s3", "s4"], failed: [], scenarios: 4 }),
      round({ solved: [], failed: ["s1", "s2", "s3", "s4"], scenarios: 4 }),
    ]);
    expect(answer.neverSolved).toBeUndefined();
  });

  it("…and it rides the ENDING too, where somebody is asking why the campaign stopped", () => {
    seq = 0;
    const answer = campaignAdoption(frame(), [
      round({ solved: ["s1"], failed: ["s2", "s3", "s4"], scenarios: 4 }),
      round({ solved: ["s1"], failed: ["s2", "s3", "s4"], scenarios: 4 }),
      round({ solved: ["s1"], failed: ["s2", "s3", "s4"], scenarios: 4 }),
    ]);
    expect(answer.kind).toBe("halt");
    if (answer.kind !== "halt") return;
    // Not `exam_inert`: this exam DOES respond, on s1. Three of four scenarios being unpassable is a fact
    // about the dataset, not an ending — a campaign may legitimately keep improving the one that works.
    expect(answer.reason).toBe("no_improvement");
    expect(answer.neverSolved).toEqual(["s2", "s3", "s4"]);
  });

  it("SILENCE IS NOT EVIDENCE: one round that cannot say withholds the whole answer", () => {
    seq = 0;
    const answer = campaignAdoption(frame(), [
      round({ solved: ["s1"], failed: ["s2", "s3", "s4"], scenarios: 4 }),
      round(),
    ]);
    expect(answer.neverSolved).toBeUndefined();
  });

  it("an unstarted campaign says nothing — there is no walk to read", () => {
    seq = 0;
    const answer = campaignAdoption(frame(), []);
    expect(answer).toEqual({ kind: "continue", roundsLeft: 10, consecutiveRejected: 0 });
  });

  it("a fully inert exam is still `exam_inert`, and names every scenario", () => {
    seq = 0;
    const dead = () => round({ solved: [], failed: ["s1", "s2", "s3", "s4"], scenarios: 4 });
    const answer = campaignAdoption(frame(), [dead(), dead(), dead()]);
    expect(answer.kind).toBe("halt");
    if (answer.kind !== "halt") return;
    expect(answer.reason).toBe("exam_inert");
    expect(answer.neverSolved).toEqual(["s1", "s2", "s3", "s4"]);
  });
});
