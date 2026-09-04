import type { RoundEvidence } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type CampaignRoundBriefInput, campaignRoundBrief } from "./round-brief.js";

// ── THE BRIEF IS WHERE THE ORACLE BOUNDARY IS ACTUALLY CROSSED ────────────────────────────────────
//
// A campaign's frame declares the boundary and no code enforced it at the handoff, because there was no
// handoff: `logRound` reads `delegationRunId` for its TTL and spend, and never asks what the delegate was
// told. The skill's `references/round-brief.md` says the right thing in prose, and prose does not bind.
//
// These are the three leaks a hand-written brief makes, each of which keeps the round GREEN — the candidate
// runs, the diff computes, the gate answers — while the evidence stops meaning anything:
//   ① a held-out case named, so the generalization population is what the delegate optimized;
//   ② a pass rate or p-value handed over, so the delegate tunes the number;
//   ③ a judge's prose rationale, so the candidate is shaped by its own evaluator's words.
//
// Observed RED before `campaignRoundBrief` existed: there was no producer at all, so every one of these was
// whatever the driver happened to type. And observed RED again with the exclusion neutralized in the
// production file (`targetTraces` iterating every case instead of the frame's targets), which is the check
// that this file pins the rule rather than the shape:
//   AssertionError: expected '{ "goal": "Change harness 'sbench'…' not to match /SECRET-HELDOUT/
//   AssertionError: expected [ 'run_cand_open', 'run_cand_heldout' ] to deeply equal [ 'run_cand_open' ]
const EVIDENCE: RoundEvidence = {
  campaignId: "evc_1",
  seq: 1,
  frameDigest: "d1",
  baseline: { scorecardId: "sc_base", version: "1.0.0" },
  candidate: { scorecardId: "sc_cand", version: "1.1.0" },
  cases: [
    {
      caseId: "t-open",
      heldOut: false,
      target: true,
      baseline: { rate: 0, trials: 6 },
      candidate: { rate: 0.8333, trials: 6 },
      delta: 0.8333,
      significant: false,
      p: 0.0152,
      method: "fisher",
      verdict: "unclear",
      traces: [
        { side: "candidate", runId: "run_cand_open", trial: 0 },
        { side: "candidate", runId: "run_cand_open_2", trial: 1 },
        { side: "baseline", runId: "run_base_open", trial: 0 },
      ],
      diagnoses: [
        {
          judge: "j1",
          kind: "spec_misread",
          locus: { tool: "read_workbook", phase: "planning" },
          evidence: [{ note: "the agent read the summary sheet and never opened the second workbook" }],
          confidence: 0.7,
        },
      ],
      attribution: { kind: "measured", slot: "image", because: ["the failing spans are the scaffold's"] },
    },
    {
      caseId: "t-done",
      heldOut: false,
      target: true,
      baseline: { rate: 0, trials: 6 },
      candidate: { rate: 1, trials: 6 },
      delta: 1,
      significant: true,
      verdict: "improved",
      traces: [{ side: "candidate", runId: "run_cand_done", trial: 0 }],
      diagnoses: [],
    },
    {
      caseId: "SECRET-HELDOUT",
      heldOut: true,
      target: false,
      baseline: { rate: 0, trials: 6 },
      candidate: { rate: 0, trials: 6 },
      delta: 0,
      significant: false,
      verdict: "unchanged",
      traces: [{ side: "candidate", runId: "run_cand_heldout", trial: 0 }],
      diagnoses: [
        {
          judge: "j1",
          kind: "tool_misuse",
          evidence: [{ note: "held-out rationale that must never reach a delegate" }],
          confidence: 0.9,
        },
      ],
    },
  ],
  aggregate: {
    comparable: true,
    significantImprovements: 1,
    significantRegressions: 0,
    heldOut: { improvements: 0, regressions: 0 },
    targets: { flipped: ["t-done"], unflipped: ["t-open"] },
  },
  at: "2026-09-04T00:00:00.000Z",
};

const input = (over: Partial<CampaignRoundBriefInput> = {}): CampaignRoundBriefInput => ({
  campaignId: "evc_1",
  seq: 2,
  issueId: "iss_1",
  frame: {
    subject: { type: "harness", id: "sbench", baselineVersion: "1.0.0" },
    scenarios: [
      { id: "t-open", heldOut: false },
      { id: "t-done", heldOut: false },
      { id: "SECRET-HELDOUT", heldOut: true },
      { id: "SECRET-HELDOUT-2", heldOut: true },
    ],
    targets: ["t-open", "t-done"],
    trialsPerCase: 6,
    judges: ["j1"],
    oracleScope: ["tests/**", "evals/**"],
    significance: { fdrAlpha: 0.05, heldOutFamilySize: 3 },
  },
  evidence: EVIDENCE,
  learned: ["the scaffold reads only the first workbook, so multi-workbook cases lose their second answer"],
  ...over,
});

const whole = (b: ReturnType<typeof campaignRoundBrief>): string =>
  `${JSON.stringify(b, null, 1)}\n${b.goal}\n${b.context ?? ""}`;

describe("campaignRoundBrief — the handoff the platform authors", () => {
  it("① never names a held-out scenario, anywhere in the brief", () => {
    const text = whole(campaignRoundBrief(input()));
    expect(text).not.toMatch(/SECRET-HELDOUT/);
    // …and not by the back door either: the held-out case's trace is a run id like any other.
    expect(text).not.toMatch(/run_cand_heldout/);
  });

  it("② hands over no score a delegate could optimize — no rate, no delta, no p-value", () => {
    const text = whole(campaignRoundBrief(input()));
    expect(text).not.toMatch(/0\.8333|0\.0152|fisher/);
    // The one number that IS allowed is the round counter, which says nothing about how anything scored.
    expect(campaignRoundBrief(input()).context).toMatch(/Round 2 of campaign/);
  });

  it("③ carries a judge's mechanism and locus, never the judge's prose", () => {
    const brief = campaignRoundBrief(input());
    const text = whole(brief);
    expect(text).toMatch(/spec_misread/); // the kind — what routing exists to produce
    expect(text).toMatch(/read_workbook/); // the locus
    expect(text).not.toMatch(/summary sheet/); // the judge's own words
    expect(text).not.toMatch(/held-out rationale/);
  });

  it("hands over the traces of targets that are STILL failing, one each, and not the ones already flipped", () => {
    const refs = campaignRoundBrief(input()).references;
    const runs = refs.filter((r) => r.type === "run").map((r) => r.id);
    expect(runs).toEqual(["run_cand_open"]); // one per case; `run_cand_open_2` is the same failure twice
    expect(runs).not.toContain("run_cand_done"); // a flipped target spends context on finished work
    expect(refs.some((r) => r.type === "issue" && r.id === "iss_1")).toBe(true);
    expect(refs.some((r) => r.type === "harness" && r.version === "1.0.0")).toBe(true);
    expect(refs.some((r) => r.type === "scorecard" && r.id === "sc_cand")).toBe(true);
  });

  it("states a finish line the delegate can actually check, and never the scorecard", () => {
    const done = campaignRoundBrief(input()).doneWhen.join("\n");
    expect(done).toMatch(/build and tests pass/);
    expect(done).toMatch(/tests\/\*\*/); // the oracle diff check
    expect(done).toMatch(/one lever/);
    expect(done).toMatch(/resolved spec differs from 1\.0\.0/); // the same-digest refusal, stated up front
    expect(done).not.toMatch(/scorecard|significant|held-out/i);
  });

  it("says the exam is off-limits even when no oracle scope was declared — the weaker frame is the louder warning", () => {
    const bare = campaignRoundBrief(input({ frame: { ...input().frame, oracleScope: [] } }));
    expect(bare.constraints.join("\n")).toMatch(/declared no oracle scope/);
    expect(bare.doneWhen.join("\n")).not.toMatch(/touches none of/);
  });

  it("round 1 has no predecessor, so it briefs on the goal alone and hands over no traces", () => {
    const first = campaignRoundBrief(input({ seq: 1, evidence: undefined, learned: [] }));
    expect(first.context).toMatch(/Round 1 .* Nothing has been tried yet/);
    expect(first.references.filter((r) => r.type === "run")).toEqual([]);
    expect(first.goal).toMatch(/t-open, t-done/);
  });

  // ── THE RESIDUE: THE VALUES THE PREDICATE KEEPS ARE THE ONES NOBODY REVIEWED ────────────────────
  //
  // The first version filtered by `frame.targets` and that is not the same question as "may this be briefed".
  // `campaignFrameDefects` refuses a target that is also held-out at CREATION; `StoredCampaignFrameSchema` is
  // the bare shape, deliberately, so a campaign opened before that rule can hold exactly this pair — and the
  // renderer would have named the held-out case, in the goal, because the driver put it in `targets`.
  it("a LEGACY frame whose target is also held-out briefs neither the id nor its trace", () => {
    const legacy = input({
      frame: {
        ...input().frame,
        // What a pre-rule row looks like: the same id in both lists.
        scenarios: [
          { id: "t-open", heldOut: false },
          { id: "SECRET-HELDOUT", heldOut: true },
        ],
        targets: ["t-open", "SECRET-HELDOUT"],
      },
    });
    const text = whole(campaignRoundBrief(legacy));
    expect(text, "a target flag cannot promote a held-out case into the brief").not.toMatch(/SECRET-HELDOUT/);
    expect(text).not.toMatch(/run_cand_heldout/);
    expect(campaignRoundBrief(legacy).goal).toMatch(/t-open/);
  });

  it("a legacy frame whose targets are ALL held-out falls back to the aggregate goal, naming nothing", () => {
    const g = campaignRoundBrief(
      input({
        frame: {
          ...input().frame,
          scenarios: [{ id: "SECRET-HELDOUT", heldOut: true }],
          targets: ["SECRET-HELDOUT"],
        },
      }),
    ).goal;
    expect(g).toMatch(/more of this campaign's scenarios/);
    expect(g).not.toMatch(/SECRET-HELDOUT/);
  });

  it("a frame with no targets still states a goal, and it is still not 'make the eval pass'", () => {
    const g = campaignRoundBrief(input({ frame: { ...input().frame, targets: [] } })).goal;
    expect(g).toMatch(/more of this campaign's scenarios/);
    expect(g).toMatch(/do not change the evaluation/);
    expect(g).not.toMatch(/SECRET-HELDOUT/);
  });
});
