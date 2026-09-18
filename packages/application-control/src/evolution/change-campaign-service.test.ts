import {
  type ChangeCampaignClose,
  type ChangeCampaignRecord,
  type ChangeCriterion,
  type ChangeRound,
  NotFoundError,
  type UnmetReason,
} from "@everdict/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChangeCampaignStore } from "../ports/change-campaign-store.js";
import type { IssueRefResolver } from "../ports/issue-ref-resolver.js";
import { ChangeCampaignService } from "./change-campaign-service.js";

// The fake lives HERE rather than being imported from `@everdict/db`: the spine runs contracts ← domain ←
// application-* ← db, so a test in this package reaching for the adapter's in-memory twin would be the
// reverse import the architecture forbids. It keeps the port's contract exactly — including the two
// conditional writes, which are the whole reason this service has tests.
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
  async count(tenant: string, options?: { issueId?: string }): Promise<number> {
    return [...this.byId.values()].filter(
      (r) => r.tenant === tenant && (options?.issueId === undefined || r.issueId === options.issueId),
    ).length;
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

// The service's own job is thin — compose the domain's refusals and CONSUME the store's conditional writes —
// so these tests are about the two things a thin service still gets wrong: letting a refusal through, and
// reporting a write that lost its race.

// ONE OF EACH KIND. A fixture whose criteria all judge the same thing exercises one branch and reports the
// other as covered — and the drift worth catching here is a requirement that quietly reads as a quality gate.
const criteria: ChangeCriterion[] = [
  { id: "tests", statement: "the suite is green", judges: { kind: "quality" } },
  { id: "device", statement: "verified on a device", judges: { kind: "requirement", issueId: "i-req" } },
];
// `observed` must point at a measurement now, so the helper carries the gate run every round declares.
const GATE = { id: "gates", command: "pnpm test", exitCode: 0, metrics: [{ name: "tests.passed", value: 4027 }] };
const met = (id: string) => ({
  criterionId: id,
  answer: "met" as const,
  how: "observed" as const,
  gateRunIds: [GATE.id],
});
const notRun = (id: string, reason: UnmetReason = "needs_environment") => ({
  criterionId: id,
  answer: "not_run" as const,
  how: "asserted" as const,
  gateRunIds: [],
  reason,
});
const changes = (sha: string) => [{ repository: "acme/widget", commits: [{ sha }] }];

// Answers the way `IssueService.get` does: either spelling resolves to the SAME record, and an unknown ref
// throws. A fake that echoed the ref back would hide the very defect these tests exist to pin.
const ISSUE_IDS: Record<string, string> = { "ENG-12": "i-1", "i-1": "i-1" };
const issues: IssueRefResolver = {
  get: async (_tenant, ref) => {
    const id = ISSUE_IDS[ref] ?? (ref.startsWith("i-") ? ref : undefined);
    if (id === undefined) throw new NotFoundError("NOT_FOUND", { id: ref }, `issue '${ref}' not found.`);
    // Only `id` is read by the service; the rest of the record is not this port's subject.
    return { id } as Awaited<ReturnType<IssueRefResolver["get"]>>;
  },
};

describe("ChangeCampaignService", () => {
  let store: FakeChangeCampaignStore;
  let svc: ChangeCampaignService;
  let seq = 0;

  beforeEach(() => {
    store = new FakeChangeCampaignStore();
    seq = 0;
    svc = new ChangeCampaignService({
      store,
      issues,
      newId: () => `cc-${++seq}`,
      now: () => "2026-09-17T00:00:00.000Z",
    });
  });

  // Each campaign gets its own request: ONE OPEN CAMPAIGN PER ISSUE is the rule now, and a fixture that
  // opened two for `i-1` is what caught it — a rule refusing a test is the rule working.
  let issueSeq = 0;
  const open = () =>
    svc.open("acme", "agent:builder", {
      issueId: `i-${++issueSeq}`,
      service: { repository: "acme/widget" },
      criteria,
    });

  it("opens against an issue with the criteria declared before the work", async () => {
    const c = await open();
    expect(c).toMatchObject({ issueId: "i-1", state: "open", criteria, rounds: [] });
  });

  // The join key. Every door takes `ENG-12` as readily as the uuid, and before this the service stored back
  // whichever spelling arrived — so a campaign opened by identifier was filed under a key the lineage read
  // (which asks by id) never looks up. Nothing failed; the campaign was simply not there, on the issue page
  // and on the project board alike.
  it("stores the id whichever spelling the request was named by", async () => {
    const byIdentifier = await svc.open("acme", "agent:builder", {
      issueId: "ENG-12",
      service: { repository: "acme/widget" },
      criteria,
    });
    expect(byIdentifier.issueId).toBe("i-1");
    // And the one-open-per-issue rule therefore sees across the two spellings, instead of letting a second
    // campaign open under the other name.
    await expect(
      svc.open("acme", "agent:builder", { issueId: "i-1", service: { repository: "acme/widget" }, criteria }),
    ).rejects.toThrow(/already has an open change campaign/);
    expect(await store.list("acme", { issueId: "i-1" })).toHaveLength(1);
  });

  it("refuses a request the workspace does not have, instead of pinning a campaign to nothing", async () => {
    await expect(
      svc.open("acme", "agent:builder", {
        issueId: "NOPE-1",
        service: { repository: "acme/widget" },
        criteria,
      }),
    ).rejects.toThrow(/issue 'NOPE-1' not found/);
    // The world is read back: a refusal that still wrote is not a refusal.
    expect(await store.list("acme")).toHaveLength(0);
  });

  it("derives the round's outcome from the answers — `not_run` cannot be adopted through", async () => {
    const c = await open();
    const adopted = await svc.logRound("acme", "agent:builder", c.id, {
      hypothesis: "disable the sheet's content pan",
      gateRuns: [GATE],
      changes: changes("aaa1111"),
      answers: [met("tests"), met("device")],
    });
    expect(adopted.round.outcome).toBe("adopted");

    const c2 = await open();
    const rejected = await svc.logRound("acme", "agent:builder", c2.id, {
      hypothesis: "same, but the device was never available",
      gateRuns: [GATE],
      changes: changes("bbb2222"),
      answers: [met("tests"), notRun("device")],
    });
    expect(rejected.round.outcome).toBe("rejected");
  });

  it("refuses a round that leaves a declared criterion unanswered", async () => {
    const c = await open();
    await expect(
      svc.logRound("acme", "agent:builder", c.id, {
        hypothesis: "h",
        gateRuns: [GATE],
        changes: changes("ccc3333"),
        answers: [met("tests")],
      }),
    ).rejects.toThrow(/unanswered criteria: device/);
  });

  it("refuses a commit a previous round already claimed", async () => {
    const c = await open();
    await svc.logRound("acme", "agent:builder", c.id, {
      hypothesis: "first try",
      gateRuns: [GATE],
      changes: changes("ddd4444"),
      answers: [met("tests"), notRun("device")],
    });
    await expect(
      svc.logRound("acme", "agent:builder", c.id, {
        hypothesis: "second try, same commit",
        gateRuns: [GATE],
        changes: changes("ddd4444"),
        answers: [met("tests"), met("device")],
      }),
    ).rejects.toThrow(/already claimed by round 1/);
  });

  // The CAS is the point, and it needs the window the service cannot close: the service re-reads immediately
  // before appending, so a stale caller is not the scenario — two callers that both read the same count are.
  // Two properties, one each:
  //   · the STORE refuses the append whose expectation no longer holds;
  //   · the SERVICE consumes that boolean instead of reporting a round nobody wrote.
  it("the store refuses an append whose expected round count no longer holds", async () => {
    const c = await open();
    const other: ChangeRound = {
      seq: 1,
      hypothesis: "the other agent's round",
      gateRuns: [GATE],
      changes: changes("eee5555"),
      judgement: { at: "2026-09-17T00:00:00.000Z", by: "agent:other", answers: [] },
      outcome: "rejected",
    };
    expect(await store.appendRound("acme", c.id, other, 0, "2026-09-17T00:00:00.000Z")).toBe(true);
    // The loser expected zero rounds too, and says so rather than overwriting the winner's.
    expect(await store.appendRound("acme", c.id, { ...other, hypothesis: "mine" }, 0, "2026-09-17T00:00:00.000Z")).toBe(
      false,
    );
  });

  it("the service turns a lost append into a CONFLICT rather than reporting a round nobody wrote", async () => {
    // Subclassed rather than spread: `{...instance}` copies own properties and leaves every prototype method
    // behind, so the "store" would have had no `create` at all — a fake that fails for the wrong reason.
    class LosingStore extends FakeChangeCampaignStore {
      override async appendRound(): Promise<boolean> {
        return false;
      }
    }
    const svcOnLoss = new ChangeCampaignService({
      store: new LosingStore(),
      issues,
      newId: () => "cc-loss",
      now: () => "2026-09-17T00:00:00.000Z",
    });
    const c = await svcOnLoss.open("acme", "agent:builder", {
      issueId: "i-1",
      service: { repository: "acme/widget" },
      criteria,
    });
    await expect(
      svcOnLoss.logRound("acme", "agent:builder", c.id, {
        hypothesis: "mine",
        gateRuns: [GATE],
        changes: changes("fff6666"),
        answers: [met("tests"), met("device")],
      }),
    ).rejects.toThrow(/another round landed/);
  });

  it("refuses to close in silence, and refuses to adopt a round that was rejected", async () => {
    const c = await open();
    await svc.logRound("acme", "agent:builder", c.id, {
      hypothesis: "h",
      gateRuns: [GATE],
      changes: changes("aaa9999"),
      answers: [met("tests"), notRun("device")],
    });
    await expect(
      svc.close("acme", "alice", c.id, {
        state: "adopted",
        reason: "ship it",
        roundSeq: 1,
        knowledge: [],
        landed: [],
        remaining: [],
      }),
    ).rejects.toThrow(/may not close in silence/);
    await expect(
      svc.close("acme", "alice", c.id, {
        state: "adopted",
        reason: "ship it",
        roundSeq: 1,
        knowledge: ["k-1"],
        landed: [],
        remaining: [],
      }),
    ).rejects.toThrow(/cannot adopt a round whose own criteria/);
  });

  it("closes once, and says so the second time", async () => {
    const c = await open();
    await svc.logRound("acme", "agent:builder", c.id, {
      hypothesis: "h",
      gateRuns: [GATE],
      changes: changes("bbb9999"),
      answers: [met("tests"), met("device")],
    });
    const closed = await svc.close("acme", "alice", c.id, {
      state: "adopted",
      reason: "criteria met",
      roundSeq: 1,
      knowledge: ["k-1"],
      landed: [],
      remaining: [],
    });
    expect(closed.state).toBe("adopted");
    expect(closed.close?.by).toBe("alice");
    await expect(
      svc.close("acme", "alice", c.id, {
        state: "abandoned",
        reason: "again",
        knowledge: ["k-2"],
        landed: [],
        remaining: [],
      }),
    ).rejects.toThrow(/already adopted/);
  });
});

// ── THE MAINTAINER'S FOUR DECISIONS, 2026-09-17 ──────────────────────────────────────────────────────
// One open campaign per issue · the agent closes a round by logging it · an observation points at numbers ·
// a request can be satisfied in pieces and the remainder picked up by a successor.
describe("ChangeCampaignService — one open campaign per issue, and the chain that follows", () => {
  let store: FakeChangeCampaignStore;
  let svc: ChangeCampaignService;
  let n = 0;

  beforeEach(() => {
    store = new FakeChangeCampaignStore();
    n = 0;
    svc = new ChangeCampaignService({
      store,
      issues,
      newId: () => `cc-${++n}`,
      now: () => "2026-09-17T00:00:00.000Z",
    });
  });

  const open = (continues?: string) =>
    svc.open("acme", "agent:builder", {
      issueId: "i-1",
      service: { repository: "acme/widget" },
      criteria,
      ...(continues !== undefined ? { continues } : {}),
    });

  it("refuses a second OPEN campaign for the same request, and names the one in the way", async () => {
    const first = await open();
    const second = svc.open("acme", "agent:builder", {
      issueId: "i-1",
      service: { repository: "acme/widget" },
      criteria,
    });
    await expect(second).rejects.toThrow(/already has an open change campaign/);
    await expect(second).rejects.toThrow(first.id); // it names the one in the way, not just the rule
  });

  it("lets the next one open once the first has ended, and records what it continues", async () => {
    const first = await open();
    await svc.close("acme", "alice", first.id, {
      state: "partially_adopted",
      reason: "the api landed, the app did not",
      knowledge: ["k-1"],
      landed: [{ repository: "acme/api" }],
      remaining: [{ repository: "acme/mobile" }],
    });
    const second = await open(first.id);
    expect(second.continues).toBe(first.id);
    expect((await svc.get("acme", first.id)).state).toBe("partially_adopted");
  });

  it("refuses to continue a campaign that is still open, or one that does not exist", async () => {
    const first = await open();
    await expect(
      svc.open("acme", "agent:builder", {
        issueId: "i-2",
        service: { repository: "acme/widget" },
        criteria,
        continues: first.id,
      }),
    ).rejects.toThrow(/continues one that has ENDED/);
    await expect(
      svc.open("acme", "agent:builder", {
        issueId: "i-3",
        service: { repository: "acme/widget" },
        criteria,
        continues: "cc-missing",
      }),
    ).rejects.toThrow(/does not exist/);
  });

  // The hole the per-campaign check left: a successor re-claiming its predecessor's commits, which made the
  // request's lineage show one sha under two attempts.
  it("refuses a commit the PREDECESSOR already claimed", async () => {
    const first = await open();
    await svc.logRound("acme", "agent:builder", first.id, {
      hypothesis: "first campaign",
      gateRuns: [GATE],
      changes: changes("abc1234"),
      answers: [met("tests"), notRun("device")],
    });
    await svc.close("acme", "alice", first.id, {
      state: "abandoned",
      reason: "wrong approach",
      knowledge: ["k-1"],
      landed: [],
      remaining: [],
    });
    const second = await open(first.id);
    await expect(
      svc.logRound("acme", "agent:builder", second.id, {
        hypothesis: "second campaign, same commit",
        gateRuns: [GATE],
        changes: changes("abc1234"),
        answers: [met("tests"), met("device")],
      }),
    ).rejects.toThrow(/already claimed by round 1/);
  });

  it("refuses an observation that names no measurement", async () => {
    const c = await open();
    await expect(
      svc.logRound("acme", "agent:builder", c.id, {
        hypothesis: "green, trust me",
        changes: changes("dd11111"),
        answers: [
          { criterionId: "tests", answer: "met" as const, how: "observed" as const, gateRunIds: [] },
          notRun("device"),
        ],
      }),
    ).rejects.toThrow(/names no gate run/);
  });
});

// ── WHAT THE CAMPAIGN IS FOR, AND HOW MUCH OF IT IS DONE ─────────────────────────────────────────────
// A request is satisfied in pieces. Until a criterion said which piece it answers, "two of the five shipped"
// was a sentence in a report and the record could not be asked.

describe("ChangeCampaignService — requirements", () => {
  let store: FakeChangeCampaignStore;
  let svc: ChangeCampaignService;
  let seq = 0;

  beforeEach(() => {
    store = new FakeChangeCampaignStore();
    seq = 0;
    svc = new ChangeCampaignService({
      store,
      issues,
      newId: () => `cc-${++seq}`,
      now: () => "2026-09-17T00:00:00.000Z",
    });
  });

  // The same join key the campaign's own issue has. A criterion pinned to `ENG-12` is invisible to every
  // reader that asks by id, and the failure renders exactly like "this requirement has no criterion".
  it("stores the id a requirement pin resolves to, not the spelling it was written with", async () => {
    const campaign = await svc.open("acme", "agent:builder", {
      issueId: "i-9",
      service: { repository: "acme/widget" },
      criteria: [
        { id: "r", statement: "the photo opens", judges: { kind: "requirement", issueId: "ENG-12" } },
        { id: "q", statement: "the suite is no worse", judges: { kind: "quality" } },
      ],
    });

    expect(campaign.criteria[0]?.judges).toEqual({ kind: "requirement", issueId: "i-1" });
  });

  it("refuses a requirement the workspace does not have, instead of counting an issue nobody can open", async () => {
    await expect(
      svc.open("acme", "agent:builder", {
        issueId: "i-9",
        service: { repository: "acme/widget" },
        criteria: [{ id: "r", statement: "?", judges: { kind: "requirement", issueId: "NOPE-1" } }],
      }),
    ).rejects.toThrow(/issue 'NOPE-1' not found/);
    expect(await store.list("acme", {})).toHaveLength(0);
  });

  // A campaign made only of quality gates passes without anyone saying what was asked for, and its count
  // reads 0 of 0 forever.
  it("refuses a campaign whose criteria never name a request", async () => {
    await expect(
      svc.open("acme", "agent:builder", {
        issueId: "i-9",
        service: { repository: "acme/widget" },
        criteria: [{ id: "q", statement: "the suite is green", judges: { kind: "quality" } }],
      }),
    ).rejects.toThrow(/no criterion names a requirement/);
  });

  // The account the maintainer asked for: how many were asked, how many settled, and why each of the rest
  // did not — as values a reader can count, off the record rather than out of a prose field.
  it("reports how much of the request settled, and what is blocking the rest", async () => {
    const campaign = await svc.open("acme", "agent:builder", {
      issueId: "i-9",
      service: { repository: "acme/widget" },
      criteria: [
        { id: "r1", statement: "place add works", judges: { kind: "requirement", issueId: "i-1" } },
        { id: "r2", statement: "the photo opens", judges: { kind: "requirement", issueId: "i-2" } },
        { id: "q", statement: "the suite is no worse", judges: { kind: "quality" } },
      ],
    });

    await svc.logRound("acme", "agent:builder", campaign.id, {
      hypothesis: "two of them are the same component",
      changes: changes("aaaaaaa"),
      gateRuns: [GATE],
      answers: [notRun("r1", "needs_information"), met("r2"), met("q")],
    });

    const view = await svc.get("acme", campaign.id);
    expect(view.requirements.total).toBe(2);
    expect(view.requirements.settled).toBe(1);
    expect(view.requirements.unsettled).toEqual([
      {
        issueId: "i-1",
        criterionIds: ["r1"],
        blockers: [{ criterionId: "r1", answer: "not_run", reason: "needs_information" }],
      },
    ]);
  });

  // "Opened, not attempted" is a real state and it is not "nothing was asked for".
  it("settles nothing before the first round, without pretending the request is empty", async () => {
    const campaign = await svc.open("acme", "agent:builder", {
      issueId: "i-9",
      service: { repository: "acme/widget" },
      criteria: [{ id: "r1", statement: "place add works", judges: { kind: "requirement", issueId: "i-1" } }],
    });

    const view = await svc.get("acme", campaign.id);
    expect(view.requirements).toMatchObject({ total: 1, settled: 0 });
  });
});
