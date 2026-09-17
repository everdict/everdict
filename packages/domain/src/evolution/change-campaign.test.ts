import type {
  ChangeCampaignRecord,
  ChangeCriterion,
  ChangeJudgementAnswer,
  ChangeRound,
  UnmetReason,
} from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  assertAnswersCoverCriteria,
  assertClosable,
  assertCommitsUnclaimed,
  assertDeclaresARequirement,
  assertObservationsMeasured,
  deriveRoundOutcome,
  summariseAnswers,
  summariseRequirements,
} from "./change-campaign.js";

// ONE OF EACH KIND, deliberately. A fixture set where every criterion judges the same thing exercises one
// branch and reports the other as covered — the drift these tests exist to catch is exactly a requirement
// that quietly reads as a quality gate.
const criteria: ChangeCriterion[] = [
  { id: "tests", statement: "the suite is green", judges: { kind: "quality" } },
  { id: "device", statement: "the gesture works on a real device", judges: { kind: "requirement", issueId: "i-9" } },
];
const answer = (
  criterionId: string,
  answerValue: ChangeJudgementAnswer["answer"],
  how: ChangeJudgementAnswer["how"] = "observed",
  gateRunIds: string[] = [],
  reason: UnmetReason = "attempted_and_failed",
): ChangeJudgementAnswer =>
  answerValue === "met"
    ? { criterionId, answer: "met", how, gateRunIds }
    : { criterionId, answer: answerValue, how, gateRunIds, reason };

const gateRun = (id: string, metrics: { name: string; value: number }[] = [{ name: "passed", value: 1 }]) => ({
  id,
  command: `pnpm ${id}`,
  exitCode: 0,
  metrics,
});

const round = (seq: number, outcome: ChangeRound["outcome"], shas: string[] = []): ChangeRound => ({
  seq,
  hypothesis: `h${seq}`,
  changes: [{ repository: "acme/widget", commits: shas.map((sha) => ({ sha })) }],
  gateRuns: [],
  judgement: { at: "2026-09-16T00:00:00.000Z", by: "agent:builder", answers: [] },
  outcome,
});

const campaign = (rounds: ChangeRound[], state: ChangeCampaignRecord["state"] = "open"): ChangeCampaignRecord => ({
  id: "cc-1",
  tenant: "acme",
  issueId: "i-1",
  service: { repository: "acme/widget" },
  criteria,
  rounds,
  state,
  createdBy: "alice",
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
});

describe("change campaign — every declared criterion is answered, and only those", () => {
  it("refuses a round that leaves a criterion unanswered", () => {
    expect(() => assertAnswersCoverCriteria(criteria, [answer("tests", "met")])).toThrow(/unanswered criteria: device/);
  });

  it("refuses an answer to a criterion nobody declared", () => {
    expect(() =>
      assertAnswersCoverCriteria(criteria, [answer("tests", "met"), answer("device", "met"), answer("vibes", "met")]),
    ).toThrow(/was not declared/);
  });

  it("refuses the same criterion answered twice", () => {
    expect(() =>
      assertAnswersCoverCriteria(criteria, [
        answer("tests", "met"),
        answer("tests", "not_met"),
        answer("device", "met"),
      ]),
    ).toThrow(/answered twice/);
  });

  it("accepts an answer set that covers the declaration exactly", () => {
    expect(() =>
      assertAnswersCoverCriteria(criteria, [answer("tests", "met"), answer("device", "not_run")]),
    ).not.toThrow();
  });
});

describe("change campaign — the outcome is derived, never declared", () => {
  it("adopts only when every criterion came back met", () => {
    expect(deriveRoundOutcome([answer("tests", "met"), answer("device", "met")])).toBe("adopted");
  });

  // The whole point of the third value: a gate nobody could reach must not read as a passed one.
  it("refuses to treat `not_run` as met", () => {
    expect(deriveRoundOutcome([answer("tests", "met"), answer("device", "not_run")])).toBe("rejected");
  });

  it("counts how the judge knew, so a self-read is distinguishable from a command", () => {
    expect(summariseAnswers([answer("tests", "met"), answer("device", "not_met", "asserted")])).toEqual({
      met: 1,
      notMet: 1,
      notRun: 0,
      observed: 1,
      asserted: 1,
    });
  });
});

describe("change campaign — a commit belongs to exactly one round", () => {
  it("refuses a commit already claimed by an earlier round", () => {
    expect(() =>
      assertCommitsUnclaimed(
        [round(1, "rejected", ["abc1234"])],
        [{ repository: "acme/widget", commits: [{ sha: "abc1234" }] }],
      ),
    ).toThrow(/already claimed by round 1/);
  });

  it("refuses the same commit twice inside ONE change set", () => {
    expect(() =>
      assertCommitsUnclaimed(
        [],
        [
          { repository: "acme/widget", commits: [{ sha: "abc1234" }] },
          { repository: "acme/widget", commits: [{ sha: "abc1234" }] },
        ],
      ),
    ).toThrow(/already claimed/);
  });

  // The same sha in two repositories is two commits — the key is (repository, sha), not the hash alone.
  it("allows the same sha in a different repository", () => {
    expect(() =>
      assertCommitsUnclaimed(
        [round(1, "rejected", ["abc1234"])],
        [{ repository: "acme/other", commits: [{ sha: "abc1234" }] }],
      ),
    ).not.toThrow();
  });
});

describe("change campaign — closing", () => {
  const learned = { knowledge: ["k-1"], reason: "shipped", landed: [], remaining: [] };

  it("refuses a close that says nothing about what the work taught", () => {
    expect(() =>
      assertClosable(campaign([round(1, "adopted")]), {
        state: "adopted",
        reason: "shipped",
        roundSeq: 1,
        knowledge: [],
        landed: [],
        remaining: [],
      }),
    ).toThrow(/may not close in silence/);
  });

  it("accepts a declared refusal instead of knowledge", () => {
    expect(() =>
      assertClosable(campaign([round(1, "adopted")]), {
        state: "adopted",
        reason: "shipped",
        roundSeq: 1,
        knowledge: [],
        landed: [],
        remaining: [],
        knowledgeDeclined: "a one-line typo fix taught nothing",
      }),
    ).not.toThrow();
  });

  it("refuses to adopt a round whose own criteria did not all come back met", () => {
    expect(() =>
      assertClosable(campaign([round(1, "rejected")]), { state: "adopted", roundSeq: 1, ...learned }),
    ).toThrow(/cannot adopt a round whose own criteria/);
  });

  it("refuses an adopted close that names no round", () => {
    expect(() => assertClosable(campaign([round(1, "adopted")]), { state: "adopted", ...learned })).toThrow(
      /names the round that carried it/,
    );
  });

  it("lets an abandoned campaign close without an adopted round, but not without a reason for what it taught", () => {
    expect(() =>
      assertClosable(campaign([round(1, "rejected")]), {
        state: "abandoned",
        reason: "the approach cannot work — recorded as a finding",
        knowledge: ["k-9"],
        landed: [],
        remaining: [],
      }),
    ).not.toThrow();
  });

  it("refuses a second close", () => {
    expect(() =>
      assertClosable(campaign([round(1, "adopted")], "adopted"), { state: "adopted", roundSeq: 1, ...learned }),
    ).toThrow(/already adopted/);
  });
});

describe("change campaign — an observation points at a measurement", () => {
  it("refuses `observed` that names no gate run", () => {
    expect(() => assertObservationsMeasured([answer("tests", "met")], [])).toThrow(/names no gate run/);
  });

  it("refuses `asserted` that cites one — if a command produced it, the word is observed", () => {
    expect(() =>
      assertObservationsMeasured([answer("tests", "met", "asserted", ["tests"])], [gateRun("tests")]),
    ).toThrow(/is marked asserted but cites gate runs/);
  });

  it("refuses a citation the round does not carry", () => {
    expect(() =>
      assertObservationsMeasured([answer("tests", "met", "observed", ["ghost"])], [gateRun("tests")]),
    ).toThrow(/which this round does not carry/);
  });

  it("accepts an observation backed by a run that reported numbers", () => {
    expect(() =>
      assertObservationsMeasured(
        [answer("tests", "met", "observed", ["tests"]), answer("device", "not_run", "asserted")],
        [
          gateRun("tests", [
            { name: "tests.passed", value: 4027 },
            { name: "tasks.total", value: 51 },
          ]),
        ],
      ),
    ).not.toThrow();
  });
});

describe("change campaign — a request can be satisfied in pieces", () => {
  const base = { reason: "two of four services are in", knowledge: ["k-1"] };

  it("refuses a partial adoption that names only one side", () => {
    expect(() =>
      assertClosable(campaign([round(1, "adopted")]), {
        state: "partially_adopted",
        ...base,
        landed: [{ repository: "acme/api" }],
        remaining: [],
      }),
    ).toThrow(/names BOTH what landed and what is still owed/);
  });

  it("accepts a partial adoption that names both, without needing an adopted round to point at", () => {
    expect(() =>
      assertClosable(campaign([round(1, "rejected")]), {
        state: "partially_adopted",
        ...base,
        landed: [{ repository: "acme/api" }],
        remaining: [{ repository: "acme/web" }, { repository: "acme/mobile" }],
      }),
    ).not.toThrow();
  });

  it("refuses landed/remaining on a FULL adoption — nothing is owed, and saying otherwise is a second ending", () => {
    expect(() =>
      assertClosable(campaign([round(1, "adopted")]), {
        state: "adopted",
        roundSeq: 1,
        ...base,
        landed: [{ repository: "acme/api" }],
        remaining: [],
      }),
    ).toThrow(/belong to a partial adoption/);
  });
});

// ── THE REQUIREMENT AXIS ─────────────────────────────────────────────────────────────────────────────
// The account a request owes its reader: how many things were asked for, how many shipped, and why each of
// the rest did not. Before `judges` existed this lived in a prose `detail` field, so a campaign could close
// with requests still owed and no query could find out.

const requirement = (id: string, issueId: string): ChangeCriterion => ({
  id,
  statement: `${id} works`,
  judges: { kind: "requirement", issueId },
});
const quality = (id: string): ChangeCriterion => ({ id, statement: `${id} holds`, judges: { kind: "quality" } });

describe("change campaign — a campaign declares what it is for", () => {
  it("refuses a campaign made only of quality gates", () => {
    expect(() => assertDeclaresARequirement([quality("tests"), quality("lint")])).toThrow(
      /no criterion names a requirement/,
    );
  });

  it("accepts one whose single requirement is the request itself", () => {
    expect(() => assertDeclaresARequirement([requirement("it-works", "i-1"), quality("tests")])).not.toThrow();
  });
});

describe("change campaign — the requirement rollup", () => {
  const five: ChangeCriterion[] = [
    requirement("r1", "i-add-place"),
    requirement("r2", "i-locked-row"),
    requirement("r3", "i-rename-path"),
    requirement("r4", "i-photo"),
    requirement("r5", "i-done-button"),
    quality("gates"),
    quality("counterexamples"),
  ];

  // The case this whole field exists for: two shipped, three did not, and the three did not fail alike.
  it("counts what was asked for and what settled, without the quality gates padding either side", () => {
    const rollup = summariseRequirements(five, [
      answer("r1", "not_run", "asserted", [], "needs_information"),
      answer("r2", "met"),
      answer("r3", "not_run", "asserted", [], "blocked_elsewhere"),
      answer("r4", "met"),
      answer("r5", "not_run", "asserted", [], "needs_environment"),
      answer("gates", "met"),
      answer("counterexamples", "met"),
    ]);

    expect(rollup.total).toBe(5);
    expect(rollup.settled).toBe(2);
    expect(rollup.unsettled.map((u) => u.issueId)).toEqual(["i-add-place", "i-rename-path", "i-done-button"]);
  });

  // "Why not" is the half a reader acts on, and the three reasons above call for three different next moves.
  it("keeps each unmet requirement's reason, so the next action is readable per requirement", () => {
    const rollup = summariseRequirements(five, [
      answer("r1", "not_run", "asserted", [], "needs_information"),
      answer("r2", "met"),
      answer("r3", "not_run", "asserted", [], "blocked_elsewhere"),
      answer("r4", "met"),
      answer("r5", "not_run", "asserted", [], "needs_environment"),
      answer("gates", "met"),
      answer("counterexamples", "met"),
    ]);

    expect(rollup.unsettled.flatMap((u) => u.blockers.map((b) => b.reason))).toEqual([
      "needs_information",
      "blocked_elsewhere",
      "needs_environment",
    ]);
  });

  // A requirement that took two gates to settle is settled only when both came back — the round's own
  // arithmetic, one level down.
  it("settles a requirement only when every criterion pointed at it came back met", () => {
    const pair = [requirement("a", "i-1"), requirement("b", "i-1")];
    expect(summariseRequirements(pair, [answer("a", "met"), answer("b", "met")]).settled).toBe(1);

    const half = summariseRequirements(pair, [answer("a", "met"), answer("b", "not_met")]);
    expect(half.settled).toBe(0);
    expect(half.unsettled[0]?.criterionIds).toEqual(["a", "b"]);
    expect(half.unsettled[0]?.blockers.map((b) => b.criterionId)).toEqual(["b"]);
  });

  // Two criteria unmet for two different reasons is two different next actions. Folding them into a
  // first-wins summary is how the second one disappears.
  it("lists every blocker rather than the first one", () => {
    const pair = [requirement("a", "i-1"), requirement("b", "i-1")];
    const rollup = summariseRequirements(pair, [
      answer("a", "not_met", "asserted", [], "attempted_and_failed"),
      answer("b", "not_run", "asserted", [], "needs_environment"),
    ]);
    expect(rollup.unsettled[0]?.blockers).toEqual([
      { criterionId: "a", answer: "not_met", reason: "attempted_and_failed" },
      { criterionId: "b", answer: "not_run", reason: "needs_environment" },
    ]);
  });

  // ⚠️ Criteria that predate the distinction. Counted apart and never as either kind — folding them into
  // `quality` would report an unmet REQUEST as a passed gate (protocol L2: unknown is a third value).
  it("counts pre-migration criteria apart instead of guessing which kind they were", () => {
    const legacy: ChangeCriterion[] = [
      requirement("r1", "i-1"),
      { id: "old", statement: "written before judges existed", judges: { kind: "unclassified" } },
    ];
    const rollup = summariseRequirements(legacy, [answer("r1", "met"), answer("old", "met")]);

    expect(rollup.total).toBe(1);
    expect(rollup.settled).toBe(1);
    expect(rollup.unclassifiedCriteria).toBe(1);
  });

  // "Opened, not attempted" is not "nothing was asked for".
  it("settles nothing for a campaign that has no rounds yet", () => {
    const rollup = summariseRequirements(five, []);
    expect(rollup.total).toBe(5);
    expect(rollup.settled).toBe(0);
    expect(rollup.unsettled).toHaveLength(5);
  });
});
