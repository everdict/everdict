import type { ChangeCampaignRecord, ChangeJudgementAnswer, ChangeRound } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  assertAnswersCoverCriteria,
  assertClosable,
  assertCommitsUnclaimed,
  assertObservationsMeasured,
  deriveRoundOutcome,
  summariseAnswers,
} from "./change-campaign.js";

const criteria = [
  { id: "tests", statement: "the suite is green" },
  { id: "device", statement: "the gesture works on a real device" },
];
const answer = (
  criterionId: string,
  answerValue: ChangeJudgementAnswer["answer"],
  how: ChangeJudgementAnswer["how"] = "observed",
  gateRunIds: string[] = [],
): ChangeJudgementAnswer => ({ criterionId, answer: answerValue, how, gateRunIds });

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
