import type { ChangeCampaignClose, ChangeCampaignRecord, ChangeRound } from "@everdict/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChangeCampaignStore } from "../ports/change-campaign-store.js";
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

const criteria = [
  { id: "tests", statement: "the suite is green" },
  { id: "device", statement: "verified on a device" },
];
// `observed` must point at a measurement now, so the helper carries the gate run every round declares.
const GATE = { id: "gates", command: "pnpm test", exitCode: 0, metrics: [{ name: "tests.passed", value: 4027 }] };
const met = (id: string) => ({
  criterionId: id,
  answer: "met" as const,
  how: "observed" as const,
  gateRunIds: [GATE.id],
});
const notRun = (id: string) => ({
  criterionId: id,
  answer: "not_run" as const,
  how: "asserted" as const,
  gateRunIds: [],
});
const changes = (sha: string) => [{ repository: "acme/widget", commits: [{ sha }] }];

describe("ChangeCampaignService", () => {
  let store: FakeChangeCampaignStore;
  let svc: ChangeCampaignService;
  let seq = 0;

  beforeEach(() => {
    store = new FakeChangeCampaignStore();
    seq = 0;
    svc = new ChangeCampaignService({ store, newId: () => `cc-${++seq}`, now: () => "2026-09-17T00:00:00.000Z" });
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
    svc = new ChangeCampaignService({ store, newId: () => `cc-${++n}`, now: () => "2026-09-17T00:00:00.000Z" });
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
        answers: [{ criterionId: "tests", answer: "met", how: "observed", gateRunIds: [] }, notRun("device")],
      }),
    ).rejects.toThrow(/names no gate run/);
  });
});
