import {
  type ChangeCampaignClose,
  type ChangeCampaignRecord,
  type ChangeCriterion,
  type ChangeRound,
  type DelegateReport,
  type DelegateStatus,
  type DelegationBrief,
  NotFoundError,
  type ReadResult,
} from "@everdict/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChangeCampaignStore } from "../ports/change-campaign-store.js";
import type { DelegationReportReader, DelegationWork } from "../ports/delegation-report-reader.js";
import type { IssueRefResolver } from "../ports/issue-ref-resolver.js";
import { ChangeCampaignService } from "./change-campaign-service.js";

// ── DEFAUL-38: THE CALL THAT WAS MISSING ─────────────────────────────────────────────────────────────
//
// `DelegateReportSchema` already spoke this lane's vocabulary by explicit decision ("a report is a PROPOSED
// change round"), `reviewDelegateReport` already refused an answer set that does not correspond to its brief,
// and `logRound` already guarded hard — and nothing took a report, ran it past the brief, and landed it as a
// round naming the delegation that produced it. So a supervisor read REPORT.json with their eyes, retyped the
// judgement, and the round could not say which worker produced it.
//
// The issue's disproof, which the first test here is: "A change round whose work was performed by a delegated
// work agent, whose judgement cites the worker's answers by criterion id, which names its `delegationRunId`,
// and which comes back `rejected`. The hand-driven path already rejects 4 of 9 rounds, so automating it must
// not lose that."

class FakeChangeCampaignStore implements ChangeCampaignStore {
  private readonly byId = new Map<string, ChangeCampaignRecord>();

  async create(record: ChangeCampaignRecord): Promise<void> {
    this.byId.set(record.id, record);
  }
  async get(tenant: string, id: string): Promise<ChangeCampaignRecord | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined;
  }
  async list(tenant: string, options?: { issueId?: string; limit?: number }): Promise<ChangeCampaignRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.tenant === tenant && (options?.issueId === undefined || r.issueId === options.issueId))
      .slice(0, options?.limit ?? 200);
  }
  async appendRound(
    tenant: string,
    id: string,
    round: ChangeRound,
    expectedRounds: number,
    at: string,
  ): Promise<boolean> {
    const record = await this.get(tenant, id);
    if (!record || record.state !== "open" || record.rounds.length !== expectedRounds) return false;
    this.byId.set(id, { ...record, rounds: [...record.rounds, round], updatedAt: at });
    return true;
  }
  async close(tenant: string, id: string, close: ChangeCampaignClose, at: string): Promise<boolean> {
    const record = await this.get(tenant, id);
    if (!record || record.state !== "open") return false;
    this.byId.set(id, { ...record, state: close.state, close, updatedAt: at });
    return true;
  }
}

const issues: IssueRefResolver = {
  get: async (_tenant, ref) => {
    if (!ref.startsWith("i-")) throw new NotFoundError("NOT_FOUND", { id: ref }, `issue '${ref}' not found.`);
    return { id: ref } as Awaited<ReturnType<IssueRefResolver["get"]>>;
  },
};

// THREE CRITERIA, and the delegate answers two of them. "A report that skipped two of five criteria reads
// exactly like one that met three" is the failure this fixture exists to make visible, so the fixture has a
// skip in it rather than a clean set that would exercise only the happy arm.
const criteria: ChangeCriterion[] = [
  { id: "opens", statement: "the photo opens", judges: { kind: "requirement", issueId: "i-req" } },
  { id: "tests", statement: "the suite is no worse", judges: { kind: "quality" } },
  { id: "device", statement: "verified on a device", judges: { kind: "quality" } },
];

const brief: DelegationBrief = {
  goal: "make the photo open",
  references: [],
  constraints: [],
  doneWhen: criteria.map((c) => ({ id: c.id, statement: c.statement })),
};

const DELEGATE_GATE = {
  id: "delegate-tests",
  command: "pnpm test",
  exitCode: 0,
  metrics: [{ name: "tests.passed", value: 4027 }],
};

// The delegate claims two criteria met and says nothing at all about the third.
const report: DelegateReport = {
  summary: "Fixed the decoder; the suite is green. I could not verify on a device.",
  answers: [
    { criterionId: "opens", answer: "met", how: "observed", gateRunIds: [DELEGATE_GATE.id] },
    { criterionId: "tests", answer: "met", how: "observed", gateRunIds: [DELEGATE_GATE.id] },
  ],
  changes: [{ repository: "acme/widget", commits: [{ sha: "abc1234", message: "fix(decoder): …" }] }],
  gateRuns: [DELEGATE_GATE],
  blockers: ["no device in the container"],
  questions: [],
};

function readerFor(
  work: Partial<DelegationWork> & { status?: DelegateStatus },
  answer?: ReadResult<DelegationWork>,
): DelegationReportReader {
  return {
    read: async (): Promise<ReadResult<DelegationWork>> =>
      answer ?? {
        kind: "read",
        value: { runId: "run-delegate", brief, report, status: "completed", ...work },
      },
  };
}

describe("a change round performed by a delegated work agent (DEFAUL-38)", () => {
  let store: FakeChangeCampaignStore;
  let seq = 0;

  const serviceWith = (delegations?: DelegationReportReader): ChangeCampaignService =>
    new ChangeCampaignService({
      store,
      issues,
      ...(delegations ? { delegations } : {}),
      newId: () => `cc-${++seq}`,
      now: () => "2026-09-18T00:00:00.000Z",
    });

  beforeEach(() => {
    store = new FakeChangeCampaignStore();
    seq = 0;
  });

  let issueSeq = 0;
  const openDelegated = (svc: ChangeCampaignService) =>
    svc.open("acme", "agent:supervisor", {
      issueId: `i-${++issueSeq}`,
      service: { repository: "acme/widget" },
      criteria,
      delegation: { required: true },
    });

  // ── THE DISPROOF ─────────────────────────────────────────────────────────────────────────────────
  //
  // Seen RED under its own neutralization — the round built without `delegation: delegated.round`, which is
  // exactly the pre-change state (`change-campaign-service.ts` had zero delegation references):
  //   "expected undefined to be 'run-delegate'"  →  the round cannot say which worker produced it.
  it("names its delegation, echoes the worker's answers by criterion id, and is REJECTED on the supervisor's verdict", async () => {
    const svc = serviceWith(readerFor({}));
    const campaign = await openDelegated(svc);

    // The supervisor accepts two of the delegate's claims and refuses the third — the one the delegate never
    // answered. The delegate said nothing about `device`; the SUPERVISOR is the one who says what that means.
    const { round } = await svc.logRound("acme", "agent:supervisor", campaign.id, {
      hypothesis: "the decoder rejected progressive JPEGs",
      changes: [],
      answers: [
        { criterionId: "opens", answer: "met", how: "observed", gateRunIds: [DELEGATE_GATE.id] },
        { criterionId: "tests", answer: "met", how: "observed", gateRunIds: [DELEGATE_GATE.id] },
        {
          criterionId: "device",
          answer: "not_run",
          how: "asserted",
          gateRunIds: [],
          reason: "needs_environment",
        },
      ],
      delegationRunId: "run-delegate",
    });

    // …and it comes back REJECTED. The hand-driven path rejects 4 of 9 rounds; automating it must not lose that.
    expect(round.outcome).toBe("rejected");
    expect(round.judgement.by).toBe("agent:supervisor");
    expect(round.delegation?.runId).toBe("run-delegate");
    // The join: one entry per DECLARED criterion, in declaration order, keyed by the id both sides minted.
    expect(round.delegation?.reported).toEqual([
      { kind: "answered", criterionId: "opens", answer: "met", how: "observed" },
      { kind: "answered", criterionId: "tests", answer: "met", how: "observed" },
      // ⚠️ THE SKIP IS A ROW. Before this, a criterion the delegate never answered was an ABSENCE — nothing
      // to see unless somebody counted, which is why "skipped two of five" reads like "met three".
      { kind: "unanswered", criterionId: "device" },
    ]);
    // What it was actually ASKED, read from the authored brief rather than re-parsed out of BRIEF.md.
    expect(round.delegation?.briefedOn).toEqual(["opens", "tests", "device"]);
    expect(round.delegation?.blockers).toEqual(["no device in the container"]);
    // The change set and the measurement are the DELEGATE's, carried through rather than retyped.
    expect(round.changes).toEqual(report.changes);
    expect(round.gateRuns).toEqual([DELEGATE_GATE]);
  });

  // ⚠️ THE DELEGATE DOES NOT GRADE ITS OWN EXAM. The report claims everything met; the supervisor does not.
  // The round follows the SUPERVISOR. Seen RED with the service neutralized to default the judgement to
  // `report.answers`:
  //   "expected 'adopted' to be 'rejected'"  →  the delegate adopted its own round.
  // That is the whole reason the two are different fields rather than one with a fallback.
  it("does not let the report become the judgement — a delegate claiming everything met cannot adopt its own round", async () => {
    const boastful: DelegateReport = {
      ...report,
      answers: criteria.map((c) => ({
        criterionId: c.id,
        answer: "met" as const,
        how: "observed" as const,
        gateRunIds: [DELEGATE_GATE.id],
      })),
    };
    const svc = serviceWith(readerFor({ report: boastful }));
    const campaign = await openDelegated(svc);

    const { round } = await svc.logRound("acme", "agent:supervisor", campaign.id, {
      hypothesis: "the decoder rejected progressive JPEGs",
      changes: [],
      answers: [
        { criterionId: "opens", answer: "met", how: "observed", gateRunIds: [DELEGATE_GATE.id] },
        { criterionId: "tests", answer: "met", how: "observed", gateRunIds: [DELEGATE_GATE.id] },
        {
          criterionId: "device",
          answer: "not_met",
          how: "asserted",
          gateRunIds: [],
          reason: "attempted_and_failed",
        },
      ],
      delegationRunId: "run-delegate",
    });

    expect(round.outcome).toBe("rejected");
    // Both verdicts survive, side by side, so a later reader can see they disagreed.
    expect(round.judgement.answers.find((a) => a.criterionId === "device")?.answer).toBe("not_met");
    expect(round.delegation?.reported).toContainEqual({
      kind: "answered",
      criterionId: "device",
      answer: "met",
      how: "observed",
    });
  });

  it("refuses a round that names no delegation when the campaign declared that its rounds are delegated", async () => {
    const svc = serviceWith(readerFor({}));
    const campaign = await openDelegated(svc);

    await expect(
      svc.logRound("acme", "agent:supervisor", campaign.id, {
        hypothesis: "I did it myself",
        changes: [{ repository: "acme/widget", commits: [{ sha: "dead123" }] }],
        gateRuns: [DELEGATE_GATE],
        answers: criteria.map((c) => ({
          criterionId: c.id,
          answer: "met" as const,
          how: "observed" as const,
          gateRunIds: [DELEGATE_GATE.id],
        })),
      }),
    ).rejects.toThrow(/must name the sandbox session that produced its work/);

    // …and nothing was written. A refusal asserted only by "it threw" cannot tell a guard from the crash a
    // missing guard would cause (rule `testing`).
    expect((await svc.get("acme", campaign.id)).rounds).toEqual([]);
  });

  // A delegation the control plane could not read is NOT a delegation that produced nothing (protocol L2).
  // The round would otherwise claim work whose evidence is unreachable.
  it("refuses a round whose delegation could not be read, rather than logging it without one", async () => {
    const svc = serviceWith(
      readerFor({}, { kind: "unknown", reason: "the session is no longer live on this control plane" }),
    );
    const campaign = await openDelegated(svc);

    await expect(
      svc.logRound("acme", "agent:supervisor", campaign.id, {
        hypothesis: "the decoder rejected progressive JPEGs",
        changes: [],
        answers: criteria.map((c) => ({
          criterionId: c.id,
          answer: "met" as const,
          how: "asserted" as const,
          gateRunIds: [],
        })),
        delegationRunId: "run-delegate",
      }),
    ).rejects.toThrow(/could not be read/);
    expect((await svc.get("acme", campaign.id)).rounds).toEqual([]);
  });

  it("refuses a round naming a delegation this workspace does not have", async () => {
    const svc = serviceWith(readerFor({}, { kind: "absent" }));
    const campaign = await openDelegated(svc);

    await expect(
      svc.logRound("acme", "agent:supervisor", campaign.id, {
        hypothesis: "h",
        changes: [],
        answers: criteria.map((c) => ({
          criterionId: c.id,
          answer: "met" as const,
          how: "asserted" as const,
          gateRunIds: [],
        })),
        delegationRunId: "run-nobody",
      }),
    ).rejects.toThrow(/is not a delegation this workspace holds/);
  });

  it("refuses a round from a delegate that is still running — an outcome nobody has observed", async () => {
    const svc = serviceWith(readerFor({ status: "running" }));
    const campaign = await openDelegated(svc);

    await expect(
      svc.logRound("acme", "agent:supervisor", campaign.id, {
        hypothesis: "h",
        changes: [],
        answers: criteria.map((c) => ({
          criterionId: c.id,
          answer: "met" as const,
          how: "asserted" as const,
          gateRunIds: [],
        })),
        delegationRunId: "run-delegate",
      }),
    ).rejects.toThrow(/would claim an outcome nobody has observed/);
    expect((await svc.get("acme", campaign.id)).rounds).toEqual([]);
  });

  // "Finished without telling me what it did" is a fact, and an empty report would erase it by looking
  // exactly like a delegate that answered nothing.
  it("refuses a round from a delegate that ended without filing a report", async () => {
    const svc = serviceWith({
      read: async () => ({ kind: "read", value: { runId: "run-delegate", brief, status: "completed" } }),
    });
    const campaign = await openDelegated(svc);

    await expect(
      svc.logRound("acme", "agent:supervisor", campaign.id, {
        hypothesis: "h",
        changes: [],
        answers: criteria.map((c) => ({
          criterionId: c.id,
          answer: "met" as const,
          how: "asserted" as const,
          gateRunIds: [],
        })),
        delegationRunId: "run-delegate",
      }),
    ).rejects.toThrow(/ended without filing a report/);
  });

  it("refuses a delegated round whose change set the supervisor retyped", async () => {
    const svc = serviceWith(readerFor({}));
    const campaign = await openDelegated(svc);

    await expect(
      svc.logRound("acme", "agent:supervisor", campaign.id, {
        hypothesis: "h",
        changes: [{ repository: "acme/widget", commits: [{ sha: "abc1234" }] }],
        answers: criteria.map((c) => ({
          criterionId: c.id,
          answer: "met" as const,
          how: "observed" as const,
          gateRunIds: [DELEGATE_GATE.id],
        })),
        delegationRunId: "run-delegate",
      }),
    ).rejects.toThrow(/takes its change set from the delegate's report/);
  });

  it("refuses a verification gate run reusing the delegate's own gate id — one number, two authors", async () => {
    const svc = serviceWith(readerFor({}));
    const campaign = await openDelegated(svc);

    await expect(
      svc.logRound("acme", "agent:supervisor", campaign.id, {
        hypothesis: "h",
        changes: [],
        gateRuns: [{ ...DELEGATE_GATE, metrics: [{ name: "tests.passed", value: 1 }] }],
        answers: criteria.map((c) => ({
          criterionId: c.id,
          answer: "met" as const,
          how: "observed" as const,
          gateRunIds: [DELEGATE_GATE.id],
        })),
        delegationRunId: "run-delegate",
      }),
    ).rejects.toThrow(/needs its own id/);
  });

  // The supervisor's OWN verification run rides beside the delegate's, under its own id and its own author.
  it("carries the supervisor's own verification gate beside the delegate's measurement", async () => {
    const svc = serviceWith(readerFor({}));
    const campaign = await openDelegated(svc);
    const verification = {
      id: "supervisor-typecheck",
      command: "pnpm typecheck",
      exitCode: 0,
      metrics: [{ name: "tasks.total", value: 51 }],
    };

    const { round } = await svc.logRound("acme", "agent:supervisor", campaign.id, {
      hypothesis: "h",
      changes: [],
      gateRuns: [verification],
      answers: criteria.map((c) => ({
        criterionId: c.id,
        answer: "met" as const,
        how: "observed" as const,
        gateRunIds: [verification.id],
      })),
      delegationRunId: "run-delegate",
    });

    expect(round.outcome).toBe("adopted");
    expect(round.gateRuns.map((g) => g.id)).toEqual([DELEGATE_GATE.id, verification.id]);
  });

  // An answer to an id this campaign never declared is a finding, never a contribution — a delegate answering
  // an older brief LOOKS valid until somebody checks the id.
  it("records the criteria the delegate answered that this campaign never declared", async () => {
    const stale: DelegateReport = {
      ...report,
      answers: [...report.answers, { criterionId: "thumbnail", answer: "met", how: "asserted", gateRunIds: [] }],
    };
    const svc = serviceWith(readerFor({ report: stale }));
    const campaign = await openDelegated(svc);

    const { round } = await svc.logRound("acme", "agent:supervisor", campaign.id, {
      hypothesis: "h",
      changes: [],
      answers: criteria.map((c) => ({
        criterionId: c.id,
        answer: "met" as const,
        how: "observed" as const,
        gateRunIds: [DELEGATE_GATE.id],
      })),
      delegationRunId: "run-delegate",
    });

    expect(round.delegation?.unknownCriteria).toEqual(["thumbnail"]);
    // …and it did not become an answer: the judgement still covers exactly the declaration.
    expect(round.judgement.answers.map((a) => a.criterionId)).toEqual(["opens", "tests", "device"]);
  });

  // A declaration that cannot be satisfied is refused where it is MADE, not one round at a time.
  it("refuses to open a delegated campaign on a deployment that cannot read delegate reports", async () => {
    const svc = serviceWith(undefined);
    await expect(
      svc.open("acme", "agent:supervisor", {
        issueId: "i-99",
        service: { repository: "acme/widget" },
        criteria,
        delegation: { required: true },
      }),
    ).rejects.toThrow(/cannot read delegate reports/);
  });

  // An ordinary campaign is untouched: a round with no delegation is the ordinary case and reads as such.
  it("leaves an undelegated campaign's rounds exactly as they were", async () => {
    const svc = serviceWith(readerFor({}));
    const campaign = await svc.open("acme", "agent:builder", {
      issueId: "i-50",
      service: { repository: "acme/widget" },
      criteria,
    });

    const { round } = await svc.logRound("acme", "agent:builder", campaign.id, {
      hypothesis: "I did it myself",
      changes: [{ repository: "acme/widget", commits: [{ sha: "feed123" }] }],
      gateRuns: [DELEGATE_GATE],
      answers: criteria.map((c) => ({
        criterionId: c.id,
        answer: "met" as const,
        how: "observed" as const,
        gateRunIds: [DELEGATE_GATE.id],
      })),
    });

    expect(round.delegation).toBeUndefined();
    expect(round.outcome).toBe("adopted");
    expect(round.changes).toEqual([{ repository: "acme/widget", commits: [{ sha: "feed123" }] }]);
  });
});
