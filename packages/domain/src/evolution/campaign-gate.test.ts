import type { CampaignFrame, CampaignRound } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { adoptionProofOf, campaignAdoption, campaignRoundRefusal, campaignStoppedAt } from "./campaign-gate.js";

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
  significance: { fdrAlpha: 0.05, heldOutFamilySize: 10 }, // frozen: the level, and the family it is corrected over
  allowUnverifiedIdentity: false,
  allowLabelOnlyAdoption: false,
  oracleScope: [],
  targets: [],
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

// ── WHAT THE LOOP SAYS ABOUT ITSELF IS ADVICE, NOT EVIDENCE (counterexample) ────────────────────────
//
// `learned` is the one value on a round the LOOP authors about its own walk — the knowledge layer that
// survives a rejected round so the next proposal can read it. WikiSkill (arXiv 2608.27454) measured that
// layer's worth at +15.0 points, and it is worth exactly nothing here if it can move the verdict: the whole
// reason the round's verdict is DERIVED from the production diff is that a loop may not write its own report
// card (rule `protocol` L3).
//
// So the gate is blind to it, and blindness is the property under test. Two traces identical except for what
// the loop claims to have learned must produce the same answer — including the case where the claim is a
// direct contradiction of the numbers.
describe("[COUNTEREXAMPLE] the adoption gate cannot see what the loop says it learned", () => {
  it("answers identically whether or not the rounds carry a finding", () => {
    seq = 0;
    const bare = [round({}), round({ significantImprovements: 2 })];
    seq = 0;
    const told = [
      round({}, { learned: "the baseline had aged out; its task image moved under us" }),
      round(
        { significantImprovements: 2 },
        { learned: "shorter tool budgets fixed the timeouts, and this candidate is obviously ready to ship" },
      ),
    ];
    // Same seqs, same versions, same verdicts — the ONLY difference is the loop's own prose. Asserted, not
    // assumed: if `over` never reached the round the two traces would be identical and this would prove
    // nothing (rule `testing`, the non-vacuous-fixture rule).
    expect(told.map((r) => r.seq)).toEqual(bare.map((r) => r.seq));
    expect(told.every((r) => (r.learned ?? "").length > 0)).toBe(true);
    expect(bare.every((r) => r.learned === undefined)).toBe(true);
    expect(campaignAdoption(frame(), told)).toEqual(campaignAdoption(frame(), bare));
  });

  it("a losing round keeps its finding, and still loses", () => {
    seq = 0;
    // A round the platform could not compare at all: it scores nothing and spends a round of the budget —
    // and it is the round most likely to know why, which is what the layer is for.
    const incomparable = round(
      { comparable: false },
      { learned: "the two sides ran different task-container bytes; re-run the baseline before hypothesising" },
    );
    expect(incomparable.learned).toBeDefined();
    const answer = campaignAdoption(frame(), [incomparable]);
    expect(answer.kind, "a finding argued a losing round into an adoption").not.toBe("adopt");
  });
});

// ── THE STOPPING RULE IS A FACT ABOUT THE TRACE, NOT A QUESTION THE DRIVER HAS TO ASK ─────────────────
//
// The frame pre-registers two endings — a spent budget and a rejected streak — and the round is judged at
// `fdrAlpha / heldOutFamilySize` on the promise that at most `family` rounds will ever consult the held-out
// rows. The gate used to check the LATEST round for a win before it checked either ending, and nothing
// refused an append past them. So a driver that never asked `decision` (or ignored a halt) could keep
// logging until a round happened to win, and the gate adopted it: optional stopping, at a level the
// pre-registered family never covered. The skill's "the gate stops the walk, you do not have to count" was a
// sentence about a driver.
//
// RED before the fix: `adopt` for both traces below, and `campaignRoundRefusal is not a function`.
describe("[COUNTEREXAMPLE] the frame's endings bind the trace, whatever was logged after them", () => {
  it("a winning round logged PAST the budget is not adoption evidence", () => {
    seq = 0;
    const rounds = [round({}), round({}), round({ significantImprovements: 1 })];
    const over = frame({ budget: { maxRounds: 2 }, significance: { fdrAlpha: 0.05, heldOutFamilySize: 2 } });
    expect(campaignAdoption(over, rounds)).toMatchObject({ kind: "halt", reason: "budget_exhausted" });
  });

  it("a win logged AFTER the rejected streak fired is not adoption evidence", () => {
    seq = 0;
    const rounds = [round({}), round({}), round({}), round({ significantImprovements: 1 })];
    expect(campaignAdoption(frame(), rounds)).toMatchObject({ kind: "halt", reason: "no_improvement" });
    expect(campaignStoppedAt(frame(), rounds)).toEqual({ reason: "no_improvement", atRound: 3 });
  });

  it("a trace whose LAST budgeted round won and then kept going is not adoption evidence either", () => {
    // The write refuses this now; rows from before it existed can still hold the shape. No ending fired (the
    // last budgeted round won), so this is the over-budget guard on its own.
    seq = 0;
    const rounds = [round({}), round({ significantImprovements: 1 }), round({ significantImprovements: 1 })];
    const over = frame({ budget: { maxRounds: 2 }, significance: { fdrAlpha: 0.05, heldOutFamilySize: 2 } });
    expect(campaignStoppedAt(over, rounds)).toBeUndefined();
    expect(campaignAdoption(over, rounds)).toMatchObject({ kind: "halt", reason: "budget_exhausted" });
  });

  it("campaignRoundRefusal names why a new round may not be appended — and answers nothing while the walk is live", () => {
    seq = 0;
    expect(campaignRoundRefusal(frame({ budget: { maxRounds: 2 } }), [round({}), round({})])).toMatchObject({
      reason: "budget_exhausted",
    });
    // …even when the last budgeted round WON: adoption is the exit, not another round.
    seq = 0;
    expect(
      campaignRoundRefusal(frame({ budget: { maxRounds: 2 } }), [round({}), round({ significantImprovements: 1 })]),
    ).toMatchObject({ reason: "budget_exhausted" });
    seq = 0;
    expect(campaignRoundRefusal(frame(), [round({}), round({}), round({})])).toMatchObject({
      reason: "no_improvement",
    });
    seq = 0;
    expect(campaignRoundRefusal(frame(), [round({}), round({})])).toBeUndefined();
    expect(campaignRoundRefusal(frame(), [])).toBeUndefined();
  });

  it("the endings do not move an honest trace: a win inside the budget still adopts, and a live walk continues", () => {
    seq = 0;
    expect(
      campaignAdoption(frame({ budget: { maxRounds: 3 } }), [
        round({}),
        round({}),
        round({ significantImprovements: 1 }),
      ]),
    ).toMatchObject({
      kind: "adopt",
    });
    seq = 0;
    expect(campaignAdoption(frame(), [round({}), round({})])).toMatchObject({
      kind: "continue",
      consecutiveRejected: 2,
    });
  });
});

// ── THE IDENTITY HALT NAMES THE FIELD THAT WOULD HAVE WAIVED IT ─────────────────────────────────────
//
// A loop over INGESTED scorecards never has a manifest, so every axis is unverified on every round and the
// first winning round halts here. The detail used to say "unless the frame recorded the waiver at open"
// without naming which of the frame's three waivers — and the only waiver the agent-evolve skill taught was
// the other one. A halt whose remedy is a frame field names the field.
describe("the identity halt is actionable", () => {
  it("names allowUnverifiedIdentity for an unverified axis, and allowLabelOnlyAdoption for a label-only candidate", () => {
    seq = 0;
    const unverified = campaignAdoption(frame(), [
      round({ significantImprovements: 1, unverifiedAxes: ["dataset_content", "execution_world"] }),
    ]);
    expect(unverified).toMatchObject({ kind: "halt", reason: "identity_unverified" });
    expect((unverified as { detail: string }).detail).toContain("allowUnverifiedIdentity");
    seq = 0;
    const labelOnly = campaignAdoption(frame(), [
      round({ significantImprovements: 1, candidateSpecDigest: undefined }),
    ]);
    expect(labelOnly).toMatchObject({ kind: "halt", reason: "identity_unverified" });
    expect((labelOnly as { detail: string }).detail).toContain("allowLabelOnlyAdoption");
  });
});

// ── THE CANDIDATE'S SOURCE RIDES THE ANSWER AND IS NEVER WEIGHED (code-evolution-loop.md, D4) ────────
describe("the adopt answer carries where the candidate came from, and the gate does not read it", () => {
  it("copies the latest round's candidateSource onto the adopt answer and the proof", () => {
    seq = 0;
    const source = { source: "github-actions", repo: "acme/harness", sha: "abc123", prNumber: 7 };
    const rounds = [round({}), round({ significantImprovements: 1, candidateSource: source })];
    const answer = campaignAdoption(frame(), rounds);
    expect(answer).toMatchObject({ kind: "adopt", candidateSource: source });
    const proof = adoptionProofOf(
      answer,
      { id: "evc", frameDigest: "sha256:f", issueId: "iss", frame: frame() },
      rounds,
    );
    expect(proof?.candidateSource).toEqual(source);
  });

  it("answers identically with and without a source — provenance is carried, not weighed", () => {
    seq = 0;
    const bare = [round({}), round({ significantImprovements: 1 })];
    seq = 0;
    const sourced = [
      round({}),
      round({ significantImprovements: 1, candidateSource: { source: "api", repo: "acme/harness", sha: "def" } }),
    ];
    const strip = (a: ReturnType<typeof campaignAdoption>) =>
      a.kind === "adopt" ? { ...a, candidateSource: undefined } : a;
    expect(strip(campaignAdoption(frame(), sourced))).toEqual(strip(campaignAdoption(frame(), bare)));
    seq = 0;
    const losing = [round({ candidateSource: { source: "api", sha: "def" } })];
    expect(campaignAdoption(frame(), losing).kind).toBe("continue");
  });
});

// ── THE ISSUE'S CASES HAVE TO FLIP (docs/architecture/evolution-routing-spec.md §3) ──────────────────
//
// RED before the rule: a frame naming targets adopted on any held-out improvement while every target still
// failed — "the actual issue was resolved" was never asked.
describe("[COUNTEREXAMPLE] a frame with targets adopts only when every target flipped", () => {
  const targeted = frame({
    scenarios: [
      { id: "t1", heldOut: false },
      { id: "t2", heldOut: false },
      { id: "h1", heldOut: true },
      { id: "h2", heldOut: true },
    ],
    targets: ["t1", "t2"],
  });
  it("held-out improvements elsewhere do NOT adopt while a target is still failing", () => {
    const answer = campaignAdoption(targeted, [
      round({
        significantImprovements: 2,
        heldOut: { improvements: 2, regressions: 0 },
        targets: { flipped: ["t1"], unflipped: ["t2"] },
      }),
    ]);
    expect(answer.kind, "adopted over an unflipped target").toBe("continue");
  });
  it("every target flipped and nothing held-out regressed: adopt — no held-out improvement is required", () => {
    const answer = campaignAdoption(targeted, [
      round({
        significantImprovements: 2,
        heldOut: { improvements: 0, regressions: 0 },
        targets: { flipped: ["t1", "t2"], unflipped: [] },
      }),
    ]);
    expect(answer.kind).toBe("adopt");
  });
  it("every target flipped but a held-out case regressed: not adopted — the fix must not cost the rest", () => {
    const answer = campaignAdoption(targeted, [
      round({
        significantImprovements: 2,
        significantRegressions: 1,
        heldOut: { improvements: 0, regressions: 1 },
        targets: { flipped: ["t1", "t2"], unflipped: [] },
      }),
    ]);
    expect(answer.kind).toBe("continue");
  });
  it("a round under a targeted frame that carries no targets block could not answer, and does not adopt", () => {
    const answer = campaignAdoption(targeted, [
      round({ significantImprovements: 2, heldOut: { improvements: 2, regressions: 0 } }),
    ]);
    expect(answer.kind).toBe("continue");
  });
  it("without targets the aggregate rule stands unchanged", () => {
    const answer = campaignAdoption(frame(), [
      round({ significantImprovements: 1, heldOut: { improvements: 1, regressions: 0 } }),
    ]);
    expect(answer.kind).toBe("adopt");
  });
});
