import {
  type ChangeCampaignClose,
  type ChangeCampaignRecord,
  type ChangeCriterion,
  type ChangeRound,
  NotFoundError,
} from "@everdict/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChangeCampaignStore } from "../ports/change-campaign-store.js";
import type { IssueRefResolver } from "../ports/issue-ref-resolver.js";
import { ChangeCampaignService } from "./change-campaign-service.js";

// ── DEFAUL-36: THE LIST IS A PROJECTION, AND IT SAYS IT IS A PAGE ────────────────────────────────────
//
// Measured 2026-09-18: `list_change_campaigns {limit:100}` over NINE campaigns returned 85,793 characters
// over 1,905 lines, exceeded the caller's output limit, and had to be spilled to a file and read back with a
// script. That is the read that answers "what has this workspace been changing", so it is the one that must
// fit — and the bulk of it is rounds, every one of which is reachable from `get_change_campaign`.
//
// Seen RED under its own neutralization (the list mapping `withRequirements` over the records again, which is
// exactly the pre-change body):
//   shape   — "expected undefined to be 2"                    → `rounds.total` is not there to read;
//             "expected [] to deeply equal { total: +0 }"      → `rounds` is still the array of bodies.
//   size    — "expected 11122 to be less than 8000"            → two rounds on one row already overflow it.
//   bounded — "expected 2 to be 3"                             → `available` counted the page, not the corpus.
//
// ⚠️ THE SIZE ASSERTION IS NOT THE PROTOCOL — the shape one is. A corpus that happens to be small would pass
// a byte check over an unprojected list, which is why the fixture builds rounds big enough that the
// unprojected answer cannot fit, and why the row's own `rounds.total` is asserted beside it.

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
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
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

const issues: IssueRefResolver = {
  get: async (_tenant, ref) => {
    if (!ref.startsWith("i-")) throw new NotFoundError("NOT_FOUND", { id: ref }, `issue '${ref}' not found.`);
    return { id: ref } as Awaited<ReturnType<IssueRefResolver["get"]>>;
  },
};

const criteria: ChangeCriterion[] = [
  { id: "opens", statement: "the photo opens", judges: { kind: "requirement", issueId: "i-req" } },
  { id: "tests", statement: "the suite is no worse", judges: { kind: "quality" } },
];

const GATE = {
  id: "gates",
  command: "pnpm test",
  exitCode: 0,
  metrics: [{ name: "tests.passed", value: 4027 }],
};

// A ROUND THE SIZE REAL ROUNDS ARE. The measured overflow came from prose — hypotheses, per-answer `detail`,
// and `learned` — so a fixture with one-word strings would prove the projection against a corpus that never
// overflowed in the first place (rule `testing`: a fixture that cannot reach the predicate accepts anything).
const PROSE = "x".repeat(1200);

describe("the change-campaign list is a projection (DEFAUL-36)", () => {
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
      now: () => "2026-09-18T00:00:00.000Z",
    });
  });

  const openWithRounds = async (issueId: string, rounds: number): Promise<string> => {
    const campaign = await svc.open("acme", "agent:builder", {
      issueId,
      service: { repository: "acme/widget" },
      criteria,
    });
    for (let n = 0; n < rounds; n += 1) {
      await svc.logRound("acme", "agent:builder", campaign.id, {
        hypothesis: PROSE,
        changes: [{ repository: "acme/widget", commits: [{ sha: `sha${issueId}${n}0000` }] }],
        gateRuns: [GATE],
        answers: criteria.map((c) => ({
          criterionId: c.id,
          answer: "met" as const,
          how: "observed" as const,
          gateRunIds: [GATE.id],
          detail: PROSE,
        })),
        learned: PROSE,
      });
    }
    return campaign.id;
  };

  it("returns rows without the rounds' bodies, while saying how many rounds there were", async () => {
    const id = await openWithRounds("i-1", 2);

    const page = await svc.list("acme");

    expect(page.items).toHaveLength(1);
    const row = page.items[0];
    if (row === undefined) throw new Error("the page must carry the campaign that was just opened");
    // The shape assertion — the protocol. A row says how much it withheld rather than omitting the field.
    expect(row.rounds.total).toBe(2);
    expect(row.rounds.latest).toEqual({
      seq: 2,
      outcome: "adopted",
      at: "2026-09-18T00:00:00.000Z",
      by: "agent:builder",
    });
    expect(row.criteriaCount).toBe(2);
    // …and the account the request is owed survives the projection: it is what a row is FOR.
    expect(row.requirements).toMatchObject({ total: 1, settled: 1 });
    // The bodies are gone: no hypothesis, no per-answer detail, no `learned` anywhere on the row.
    expect(JSON.stringify(row)).not.toContain(PROSE);

    // The size assertion — the measurement that forced this. Unprojected, these two rounds alone exceed it.
    expect(JSON.stringify(page).length).toBeLessThan(8000);

    // …and the detail is still one call away, whole.
    const detail = await svc.get("acme", id);
    expect(detail.rounds).toHaveLength(2);
    expect(detail.rounds[1]?.hypothesis).toBe(PROSE);
  });

  it("opened-but-never-attempted has no latest round, rather than a zeroed one nobody judged", async () => {
    await svc.open("acme", "agent:builder", {
      issueId: "i-9",
      service: { repository: "acme/widget" },
      criteria,
    });

    const row = (await svc.list("acme")).items[0];
    expect(row?.rounds).toEqual({ total: 0 });
    expect(row?.rounds.latest).toBeUndefined();
  });

  it("says how many campaigns there were, not how many fitted on the page", async () => {
    await openWithRounds("i-1", 1);
    await openWithRounds("i-2", 1);
    await openWithRounds("i-3", 1);

    const page = await svc.list("acme", { limit: 2 });

    expect(page.items).toHaveLength(2);
    // ⚠️ The whole point: a caller served 2 of 3 can TELL. Inferring it from a full page — which is what the
    // web was doing — is wrong in exactly the case where the corpus is one page long.
    expect(page.available).toBe(3);
  });

  it("counts under the same filter the page was taken under", async () => {
    await openWithRounds("i-1", 1);
    await openWithRounds("i-2", 1);

    const page = await svc.list("acme", { issueId: "i-1" });
    expect(page.items).toHaveLength(1);
    // Not 2: an `available` counted without the filter would tell a caller asking about ONE request that
    // there were more of its attempts than it was shown.
    expect(page.available).toBe(1);
  });

  it("answers another workspace nothing, page and count alike", async () => {
    await openWithRounds("i-1", 1);

    const page = await svc.list("other");
    expect(page.items).toEqual([]);
    // The count is scoped too — a twin that filtered the page and not the count would leak how much the
    // neighbouring workspace holds.
    expect(page.available).toBe(0);
  });
});
