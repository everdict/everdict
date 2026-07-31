import type { IssueRecord, ScorecardRecord } from "@everdict/contracts";
import { BadRequestError, ConflictError, ForbiddenError } from "@everdict/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import type { IssueListFilter, IssueStore } from "../ports/issue-store.js";
import type { OutboxEvent } from "../ports/run-store.js";
import type { ScorecardListFilter, ScorecardStore } from "../ports/scorecard-store.js";
import { IssueService } from "./issue-service.js";

const NOW = "2026-07-31T00:00:00.000Z";

// A minimal in-memory issue store — the db package owns the real one; here we only need the port's behaviour
// plus visibility into the outbox rows the service hands it.
class FakeIssueStore implements IssueStore {
  readonly byId = new Map<string, IssueRecord>();
  readonly events: OutboxEvent[] = [];

  async create(record: IssueRecord, events?: OutboxEvent[]): Promise<void> {
    this.byId.set(record.id, record);
    if (events) this.events.push(...events);
  }
  async get(tenant: string, id: string): Promise<IssueRecord | undefined> {
    const record = this.byId.get(id);
    return record && record.tenant === tenant ? record : undefined;
  }
  async getByGithub(): Promise<IssueRecord | undefined> {
    return undefined;
  }
  async list(tenant: string, filter?: IssueListFilter): Promise<IssueRecord[]> {
    return [...this.byId.values()].filter(
      (record) =>
        record.tenant === tenant &&
        (filter?.projectId === undefined || record.projectId === filter.projectId) &&
        (filter?.status === undefined || record.status === filter.status),
    );
  }
  async update(
    tenant: string,
    id: string,
    patch: Partial<IssueRecord>,
    events?: OutboxEvent[],
  ): Promise<IssueRecord | undefined> {
    const current = this.byId.get(id);
    if (!current || current.tenant !== tenant) return undefined;
    const next = { ...current, ...patch, id: current.id, tenant: current.tenant };
    this.byId.set(id, next);
    if (events) this.events.push(...events);
    return next;
  }
  async remove(tenant: string, id: string): Promise<void> {
    this.byId.delete(id);
  }
}

class FakeScorecardStore implements ScorecardStore {
  constructor(private readonly records: ScorecardRecord[] = []) {}
  async create(): Promise<void> {}
  async update(): Promise<ScorecardRecord | undefined> {
    return undefined;
  }
  async get(id: string): Promise<ScorecardRecord | undefined> {
    return this.records.find((r) => r.id === id);
  }
  async list(tenant?: string, filter?: ScorecardListFilter): Promise<ScorecardRecord[]> {
    return this.records.filter(
      (r) =>
        (tenant === undefined || r.tenant === tenant) &&
        (filter?.dataset === undefined || r.dataset.id === filter.dataset) &&
        (filter?.harness === undefined || r.harness.id === filter.harness),
    );
  }
  async delete(): Promise<boolean> {
    return true;
  }
}

function scorecard(over: Partial<ScorecardRecord> & { id: string }): ScorecardRecord {
  return {
    tenant: "acme",
    dataset: { id: "regression-suite", version: "1.0.0" },
    harness: { id: "web-agent", version: "2.0.0" },
    status: "succeeded",
    summary: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as ScorecardRecord;
}

describe("IssueService", () => {
  let store: FakeIssueStore;
  let ids: number;
  const actor = { subject: "dana" };

  function service(deps: { scorecards?: ScorecardStore } = {}) {
    return new IssueService({
      store,
      ...(deps.scorecards !== undefined ? { scorecards: deps.scorecards } : {}),
      newId: () => `id-${++ids}`,
      now: () => NOW,
    });
  }

  beforeEach(() => {
    store = new FakeIssueStore();
    ids = 0;
  });

  it("create persists the record and its creation fact in the same write", async () => {
    const record = await service().create({ tenant: "acme", createdBy: "dana", title: "Retry drops results" });
    expect(record.status).toBe("backlog");
    expect(store.events.map((e) => e.kind)).toEqual(["issue.created"]);
    expect(store.events[0]?.subject).toEqual({ type: "issue", id: record.id });
  });

  it("stamps an agent-authored issue with causedBy so the creator never wakes on its own fact", async () => {
    await service().create({
      tenant: "acme",
      createdBy: "triage-bot",
      title: "Auto-filed",
      agent: { agentId: "triage-bot", conversationId: "c-1" },
    });
    expect(store.events[0]?.causedBy).toBe("agent:triage-bot:c-1");
  });

  it("setStatus routes to the transition that fits the current state — move, resolve, then reopen", async () => {
    const svc = service();
    const record = await svc.create({ tenant: "acme", createdBy: "dana", title: "t" });

    const moved = await svc.setStatus("acme", record.id, { status: "in_progress" }, actor);
    expect(moved.status).toBe("in_progress");

    const resolved = await svc.setStatus("acme", record.id, { status: "done", resolution: { note: "green" } }, actor);
    expect(resolved.status).toBe("done");
    expect(resolved.resolution).toMatchObject({ note: "green", by: "dana" });

    const reopened = await svc.setStatus("acme", record.id, { status: "todo" }, actor);
    expect(reopened.status).toBe("todo");
    expect(reopened.resolution).toMatchObject({ note: "green" }); // the prior resolution survives the reopen

    expect(store.events.map((e) => e.kind)).toEqual([
      "issue.created",
      "issue.status_changed",
      "issue.status_changed",
      "issue.status_changed",
    ]);
  });

  it("validates the resolution scorecard as EVIDENCE — a foreign or missing id is a 400", async () => {
    const scorecards = new FakeScorecardStore([
      scorecard({ id: "sc-1" }),
      scorecard({ id: "sc-other", tenant: "globex" }),
    ]);
    const svc = service({ scorecards });
    const record = await svc.create({ tenant: "acme", createdBy: "dana", title: "t" });
    await expect(
      svc.setStatus("acme", record.id, { status: "done", resolution: { scorecardId: "missing" } }, actor),
    ).rejects.toThrow(BadRequestError);
    await expect(
      svc.setStatus("acme", record.id, { status: "done", resolution: { scorecardId: "sc-other" } }, actor),
    ).rejects.toThrow(BadRequestError);
    const resolved = await svc.setStatus(
      "acme",
      record.id,
      { status: "done", resolution: { scorecardId: "sc-1" } },
      actor,
    );
    expect(resolved.resolution?.scorecardId).toBe("sc-1");
  });

  it("surfaces the domain's refusals rather than silently normalizing them", async () => {
    const svc = service();
    const record = await svc.create({ tenant: "acme", createdBy: "dana", title: "t" });
    await expect(svc.setStatus("acme", record.id, { status: "backlog" }, actor)).rejects.toThrow(ConflictError);
  });

  it("evaluationHistory unions pinned evidence with everything the linked capabilities ran", async () => {
    const scorecards = new FakeScorecardStore([
      scorecard({
        id: "sc-pinned",
        dataset: { id: "other", version: "1" },
        harness: { id: "other", version: "1" },
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
      scorecard({ id: "sc-derived", createdAt: "2026-07-20T00:00:00.000Z" }),
    ]);
    const svc = service({ scorecards });
    const record = await svc.create({
      tenant: "acme",
      createdBy: "dana",
      title: "t",
      links: [
        { type: "scorecard", id: "sc-pinned" },
        { type: "dataset", id: "regression-suite" },
      ],
    });
    const history = await svc.evaluationHistory("acme", record.id);
    expect(history.scorecards.map((s) => s.id)).toEqual(["sc-derived", "sc-pinned"]); // newest first
    expect(history.linked).toEqual(["sc-pinned"]);
  });

  it("link and unlink guard duplicates and emit only for the attachment", async () => {
    const svc = service();
    const record = await svc.create({ tenant: "acme", createdBy: "dana", title: "t" });
    await svc.link("acme", record.id, { type: "harness", id: "web-agent" }, actor);
    await expect(svc.link("acme", record.id, { type: "harness", id: "web-agent" }, actor)).rejects.toThrow(
      ConflictError,
    );
    const unlinked = await svc.unlink("acme", record.id, "harness", "web-agent", actor);
    expect(unlinked.links).toEqual([]);
    expect(store.events.map((e) => e.kind)).toEqual(["issue.created", "issue.linked"]);
  });

  it("delete is creator-or-admin", async () => {
    const svc = service();
    const record = await svc.create({ tenant: "acme", createdBy: "dana", title: "t" });
    await expect(svc.remove("acme", record.id, { subject: "eve", isAdmin: false })).rejects.toThrow(ForbiddenError);
    await svc.remove("acme", record.id, { subject: "eve", isAdmin: true });
    expect(store.byId.size).toBe(0);
  });

  it("pushes to GitHub only on a status move of a push-enabled copy, and never lets it break the transition", async () => {
    const pushed: string[] = [];
    const record: IssueRecord = {
      id: "iss-1",
      tenant: "acme",
      title: "t",
      status: "todo",
      labels: [],
      links: [],
      history: [],
      github: {
        repository: "acme/agent",
        number: 42,
        url: "https://github.com/acme/agent/issues/42",
        state: "open",
        sync: { pull: true, push: true },
        comments: [],
      },
      createdBy: "dana",
      createdAt: NOW,
      updatedAt: NOW,
    };
    await store.create(record);
    const svc = new IssueService({
      store,
      github: {
        pushStatus: async (r) => {
          pushed.push(r.id);
          throw new Error("GitHub is down");
        },
      },
      newId: () => "ev",
      now: () => NOW,
    });
    const resolved = await svc.setStatus("acme", "iss-1", { status: "done" }, actor);
    expect(resolved.status).toBe("done"); // the remote failure never reaches the caller
    await svc.update("acme", "iss-1", { title: "renamed" }, actor);
    expect(pushed).toEqual(["iss-1"]); // a content edit is not a status move — no push
  });
});
