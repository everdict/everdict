import type { IssuePage, IssueRecord, ScorecardRecord } from "@everdict/contracts";
import { BadRequestError, ConflictError, ForbiddenError } from "@everdict/contracts";
import { issueCountsByTeam, issueSummaryOf } from "@everdict/domain";
import { beforeEach, describe, expect, it } from "vitest";
import type { IssueListFilter, IssuePageFilter, IssueStore, IssueTeamCounts } from "../ports/issue-store.js";
import type { OutboxEvent } from "../ports/run-store.js";
import type { ScorecardListFilter, ScorecardStore } from "../ports/scorecard-store.js";
import { IssueService } from "./issue-service.js";

// Teams are a peer concern: an issue is numbered by its team, and the tests only need that to be deterministic.
const teamAllocator = (() => {
  let n = 0;
  return {
    async allocateForIssue() {
      n += 1;
      return { team: { id: "team-eng" }, grant: { number: n, identifier: `ENG-${n}` } };
    },
  };
})();

// A move allocates from the DESTINATION team, so the test allocator answers with whichever team was asked for.
// Built per test: the counters are state, and a shared one would make each test's identifiers depend on the
// tests that ran before it.
function movingAllocator() {
  const counters = new Map<string, number>();
  const keyOf = (teamId: string) => teamId.replace("team-", "").toUpperCase();
  return {
    async allocateForIssue(_tenant: string, teamId: string | undefined) {
      const id = teamId ?? "team-eng";
      const next = (counters.get(id) ?? 0) + 1;
      counters.set(id, next);
      return { team: { id }, grant: { number: next, identifier: `${keyOf(id)}-${next}` } };
    },
  };
}

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
  async getByIdentifier(tenant: string, identifier: string): Promise<IssueRecord | undefined> {
    // Current name first, then the names the issue used to have — the real store's contract.
    const rows = [...this.byId.values()].filter((r) => r.tenant === tenant);
    return rows.find((r) => r.identifier === identifier) ?? rows.find((r) => r.formerIdentifiers.includes(identifier));
  }
  async getByGithub(): Promise<IssueRecord | undefined> {
    return undefined;
  }
  async list(tenant: string, filter?: IssueListFilter): Promise<IssueRecord[]> {
    return [...this.byId.values()].filter(
      (record) =>
        record.tenant === tenant &&
        (filter?.projectId === undefined || record.projectId === filter.projectId) &&
        (filter?.status === undefined || record.status === filter.status) &&
        (filter?.parentId === undefined ||
          (filter.parentId === null ? record.parentId === undefined : record.parentId === filter.parentId)),
    );
  }
  // Both derived from this fake's own `list` through the kernel helpers the real stores use, so the fake cannot
  // answer the list question differently from production. One page, no cursor: `list` already returns everything.
  async listSummaries(tenant: string, filter?: IssuePageFilter): Promise<IssuePage> {
    return { items: (await this.list(tenant, filter)).map(issueSummaryOf) };
  }
  async countByTeam(tenant: string): Promise<IssueTeamCounts[]> {
    return issueCountsByTeam(await this.list(tenant));
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
    priority: "none",
    inTriage: false,
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
      teams: teamAllocator,
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

  it("addresses an issue by the identifier its team minted, case-insensitively", async () => {
    const svc = service();
    const record = await svc.create({ tenant: "acme", createdBy: "dana", title: "t" });

    expect((await svc.get("acme", record.identifier)).id).toBe(record.id);
    expect((await svc.get("acme", record.identifier.toLowerCase())).id).toBe(record.id); // a pasted lowercase URL
    expect((await svc.get("acme", record.id)).id).toBe(record.id); // the id still addresses it — old links keep working

    // A mutation arriving by identifier writes against the RESOLVED id, so the transition lands on the row.
    const moved = await svc.setStatus("acme", record.identifier, { status: "in_progress" }, actor);
    expect(moved.status).toBe("in_progress");
    expect(store.byId.get(record.id)?.status).toBe("in_progress");

    // Another workspace's identifier reads as nonexistent — the same no-existence-leak rule the id path has.
    await expect(svc.get("globex", record.identifier)).rejects.toThrow(/not found/);
  });

  it("deletes the issue the identifier resolves to, not the ref it was given", async () => {
    const svc = service();
    const record = await svc.create({ tenant: "acme", createdBy: "dana", title: "t" });
    await svc.remove("acme", record.identifier, { subject: "dana", isAdmin: false });
    expect(store.byId.has(record.id)).toBe(false);
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
      teamId: "team-eng",
      number: 1,
      identifier: "ENG-1",
      formerIdentifiers: [],
      title: "t",
      status: "todo",
      priority: "none",
      inTriage: false,
      labelIds: [],
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
      teams: teamAllocator,
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

describe("IssueService.move — an issue changes teams, and its name changes with it", () => {
  const actor = { subject: "dana" };

  async function filed() {
    const store = new FakeIssueStore();
    const svc = new IssueService({ teams: movingAllocator(), store, newId: () => "ev", now: () => NOW });
    const issue = await svc.create({ tenant: "acme", createdBy: "dana", title: "flaky retry" });
    return { store, svc, issue };
  }

  it("re-mints the identifier from the destination team's counter", async () => {
    // Given: an issue filed on the default team
    const { svc, issue } = await filed();
    expect(issue.identifier).toBe("ENG-1");
    // When: it is handed to another team
    const moved = await svc.move("acme", issue.id, "team-plt", actor);
    // Then: the prefix says whose list it is on now, numbered by THAT team
    expect(moved.teamId).toBe("team-plt");
    expect(moved.identifier).toBe("PLT-1");
  });

  it("keeps the old name resolvable, so links already pasted elsewhere still land", async () => {
    const { svc, issue } = await filed();
    await svc.move("acme", issue.id, "team-plt", actor);
    // When: someone follows a link that says ENG-1
    const found = await svc.get("acme", "ENG-1");
    // Then: it is the same issue, under its current name
    expect(found.id).toBe(issue.id);
    expect(found.identifier).toBe("PLT-1");
    expect(found.formerIdentifiers).toEqual(["ENG-1"]);
  });

  it("emits issue.moved carrying both names, and appends the durable history entry", async () => {
    const { store, svc, issue } = await filed();
    await svc.move("acme", issue.id, "team-plt", actor);
    const fact = store.events.find((e) => e.kind === "issue.moved");
    expect(fact?.payload).toMatchObject({
      fromTeamId: "team-eng",
      toTeamId: "team-plt",
      fromIdentifier: "ENG-1",
      toIdentifier: "PLT-1",
    });
    expect(store.byId.get(issue.id)?.history.at(-1)?.event).toBe("moved");
  });

  it("refuses a move to the team the issue is already on", async () => {
    const { svc, issue } = await filed();
    await expect(svc.move("acme", issue.id, "team-eng", actor)).rejects.toThrow(ConflictError);
  });
});

describe("IssueService — sub-issues", () => {
  const actor = { subject: "dana" };

  function service() {
    const store = new FakeIssueStore();
    return { store, svc: new IssueService({ teams: movingAllocator(), store, newId: () => "ev", now: () => NOW }) };
  }

  it("files a sub-issue under an existing parent", async () => {
    const { svc } = service();
    const parent = await svc.create({ tenant: "acme", createdBy: "dana", title: "flaky retries" });
    const child = await svc.create({
      tenant: "acme",
      createdBy: "dana",
      title: "reproduce it",
      parentId: parent.id,
    });
    expect(child.parentId).toBe(parent.id);
  });

  it("404s on a parent that does not exist in this workspace", async () => {
    const { svc } = service();
    await expect(
      svc.create({ tenant: "acme", createdBy: "dana", title: "orphan", parentId: "iss-ghost" }),
    ).rejects.toThrow(/not found/);
  });

  it("refuses to re-parent an issue under its own sub-issue — that would close the loop", async () => {
    const { svc } = service();
    const parent = await svc.create({ tenant: "acme", createdBy: "dana", title: "parent" });
    const child = await svc.create({
      tenant: "acme",
      createdBy: "dana",
      title: "child",
      parentId: parent.id,
    });
    await expect(svc.update("acme", parent.id, { parentId: child.id }, actor)).rejects.toThrow(ConflictError);
  });

  it("refuses to delete an issue that still has sub-issues", async () => {
    const { svc } = service();
    const parent = await svc.create({ tenant: "acme", createdBy: "dana", title: "parent" });
    await svc.create({ tenant: "acme", createdBy: "dana", title: "child", parentId: parent.id });
    await expect(svc.remove("acme", parent.id, { subject: "dana", isAdmin: true })).rejects.toThrow(/sub-issue/);
  });

  it("lets an issue detach from its parent", async () => {
    const { svc } = service();
    const parent = await svc.create({ tenant: "acme", createdBy: "dana", title: "parent" });
    const child = await svc.create({ tenant: "acme", createdBy: "dana", title: "child", parentId: parent.id });
    const detached = await svc.update("acme", child.id, { parentId: null }, actor);
    expect(detached.parentId).toBeUndefined();
    // And the parent can now be deleted, because nothing points at it any more.
    await expect(svc.remove("acme", parent.id, { subject: "dana", isAdmin: true })).resolves.toBeUndefined();
  });
});

describe("IssueService — priority, estimate and due date", () => {
  const actor = { subject: "dana" };

  it("defaults to unprioritised, which is a real answer rather than an absent field", async () => {
    const store = new FakeIssueStore();
    const svc = new IssueService({ teams: movingAllocator(), store, newId: () => "ev", now: () => NOW });
    const issue = await svc.create({ tenant: "acme", createdBy: "dana", title: "x" });
    expect(issue.priority).toBe("none");
  });

  it("records each planning field in the history entry, and clears them with null", async () => {
    const store = new FakeIssueStore();
    const svc = new IssueService({ teams: movingAllocator(), store, newId: () => "ev", now: () => NOW });
    const issue = await svc.create({
      tenant: "acme",
      createdBy: "dana",
      title: "x",
      priority: "urgent",
      estimate: 3,
      dueDate: "2026-08-31",
    });
    expect(issue).toMatchObject({ priority: "urgent", estimate: 3, dueDate: "2026-08-31" });

    const edited = await svc.update("acme", issue.id, { priority: "low", estimate: null, dueDate: null }, actor);
    expect(edited.estimate).toBeUndefined();
    expect(edited.dueDate).toBeUndefined();
    expect(edited.history.at(-1)?.detail).toEqual({ changed: ["priority", "estimate", "dueDate"] });
  });
});

// The list row's thread badge. The property that matters is not the number — it is that the number costs ONE
// read for the whole page: a count per row is exactly the shape the issue list was rebuilt to remove.
describe("IssueService.listSummaries — the comment count a list row shows", () => {
  // Records the calls so the test can assert the batching, not just the totals.
  class CountingCommentStore {
    readonly calls: { resourceType: string; resourceIds: string[] }[] = [];
    constructor(private readonly counts: Record<string, number>) {}
    async countByResource(_tenant: string, resourceType: string, resourceIds: string[]) {
      this.calls.push({ resourceType, resourceIds });
      return resourceIds
        .filter((id) => this.counts[id] !== undefined)
        .map((id) => ({ resourceId: id, count: this.counts[id] ?? 0 }));
    }
    // The rest of the port is unused by the list path.
    async add() {}
    async list() {
      return [];
    }
    async get() {
      return undefined;
    }
    async update() {}
    async listStuckAgentAnswers() {
      return [];
    }
    async remove() {}
  }

  async function seeded() {
    const store = new FakeIssueStore();
    let n = 0;
    // Distinct ids on purpose: the batch is keyed BY id, so a shared stub id would make the assertion pass
    // for the wrong reason.
    const svc = new IssueService({ teams: movingAllocator(), store, newId: () => `iss-${++n}`, now: () => NOW });
    const a = await svc.create({ tenant: "acme", createdBy: "dana", title: "a" });
    const b = await svc.create({ tenant: "acme", createdBy: "dana", title: "b" });
    return { store, a, b };
  }

  it("attaches the counts in ONE batched read for the whole page, keyed as `issue`", async () => {
    const { store, a, b } = await seeded();
    const comments = new CountingCommentStore({ [a.id]: 3 });
    const svc = new IssueService({ teams: movingAllocator(), store, comments, now: () => NOW });

    const page = await svc.listSummaries("acme");

    expect(comments.calls).toHaveLength(1); // not one per row
    expect(comments.calls[0]?.resourceType).toBe("issue"); // the same key the thread itself is posted under
    expect(comments.calls[0]?.resourceIds.sort()).toEqual([a.id, b.id].sort());
    const byId = new Map(page.items.map((row) => [row.id, row.commentCount]));
    expect(byId.get(a.id)).toBe(3);
    // Absent from the aggregate = counted, and there are none. A real zero, not a missing value.
    expect(byId.get(b.id)).toBe(0);
  });

  it("leaves the count ABSENT when nothing is wired to count — undefined is not the same claim as zero", async () => {
    const { store } = await seeded();
    const svc = new IssueService({ teams: movingAllocator(), store, now: () => NOW });
    const page = await svc.listSummaries("acme");
    expect(page.items.every((row) => row.commentCount === undefined)).toBe(true);
  });

  it("asks the comment store nothing when the page is empty", async () => {
    const store = new FakeIssueStore();
    const comments = new CountingCommentStore({});
    const svc = new IssueService({ teams: movingAllocator(), store, comments, now: () => NOW });
    expect((await svc.listSummaries("acme")).items).toEqual([]);
    expect(comments.calls).toHaveLength(0);
  });
});
