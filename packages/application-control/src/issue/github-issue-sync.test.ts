import type { IssueRecord } from "@everdict/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  GithubIssue,
  GithubIssueComment,
  GithubRepoWriter,
  GithubRepoWriterFactory,
} from "../ports/github-repo-writer.js";
import type { IssueListFilter, IssueStore } from "../ports/issue-store.js";
import type { OutboxEvent } from "../ports/run-store.js";
import { GithubIssueSync } from "./github-issue-sync.js";
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

const NOW = "2026-07-31T00:00:00.000Z";
const actor = { subject: "dana" };

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
    return [...this.byId.values()].find((r) => r.tenant === tenant && r.identifier === identifier);
  }
  async getByGithub(
    tenant: string,
    repository: string,
    number: number,
    host?: string,
  ): Promise<IssueRecord | undefined> {
    return [...this.byId.values()].find(
      (r) =>
        r.tenant === tenant &&
        r.github?.repository === repository &&
        r.github.number === number &&
        r.github.host === host,
    );
  }
  async list(tenant: string, filter?: IssueListFilter): Promise<IssueRecord[]> {
    return [...this.byId.values()].filter(
      (r) =>
        r.tenant === tenant &&
        (filter?.githubRepository === undefined || r.github?.repository === filter.githubRepository) &&
        (filter?.syncPull !== true || r.github?.sync.pull === true),
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

interface RemoteState {
  issues: Map<number, GithubIssue>;
  comments: GithubIssueComment[];
  patched: Array<{ number: number; state: string }>;
  postedComments: Array<{ number: number; body: string }>;
  failWrites?: string;
  listCalls: Array<{ since?: string; state?: string }>;
}

function remoteIssue(over: Partial<GithubIssue> & { number: number }): GithubIssue {
  return {
    title: "Retry drops tool results",
    state: "open",
    author: "kim",
    url: `https://github.com/acme/agent/issues/${over.number}`,
    isPullRequest: false,
    updatedAt: "2026-07-31T10:00:00.000Z",
    labels: [],
    ...over,
  };
}

function fakeWriters(remote: RemoteState): GithubRepoWriterFactory {
  const writer: GithubRepoWriter = {
    async repoHead() {
      throw new Error("unused");
    },
    async ensureBranch() {},
    async putFile() {},
    async openPr() {
      throw new Error("unused");
    },
    async getFile() {
      throw new Error("unused");
    },
    async listIssues(_repository, opts) {
      remote.listCalls.push({
        ...(opts.since !== undefined ? { since: opts.since } : {}),
        ...(opts.state !== undefined ? { state: opts.state } : {}),
      });
      const all = [...remote.issues.values()];
      const since = opts.since;
      return since === undefined ? all : all.filter((i) => i.updatedAt > since);
    },
    async getIssue(_repository, number) {
      const found = remote.issues.get(number);
      if (!found) throw new Error(`no such issue ${number}`);
      return found;
    },
    async updateIssue(_repository, number, patch) {
      if (remote.failWrites) throw new Error(remote.failWrites);
      remote.patched.push({ number, state: patch.state });
    },
    async listIssueComments() {
      return remote.comments;
    },
    async createIssue() {
      throw new Error("unused");
    },
    async createIssueComment(_repository, number, body) {
      if (remote.failWrites) throw new Error(remote.failWrites);
      remote.postedComments.push({ number, body });
      return { url: "https://github.com/acme/agent/issues/1#issuecomment-1" };
    },
  };
  return { for: () => writer };
}

describe("GithubIssueSync — import", () => {
  let store: FakeIssueStore;
  let remote: RemoteState;

  function build() {
    const issues = new IssueService({ store, teams: teamAllocator, now: () => NOW });
    const sync = new GithubIssueSync({
      store,
      issues,
      teams: teamAllocator,
      tokens: { tokenForRepository: async () => ({ token: "tok" }) },
      writers: fakeWriters(remote),
      now: () => NOW,
    });
    return { issues, sync };
  }

  beforeEach(() => {
    store = new FakeIssueStore();
    remote = { issues: new Map(), comments: [], patched: [], postedComments: [], listCalls: [] };
  });

  it("copies an open issue as todo and a closed one as done WITHOUT inventing evidence", async () => {
    remote.issues.set(1, remoteIssue({ number: 1, body: "steps", labels: ["bug"] }));
    remote.issues.set(2, remoteIssue({ number: 2, state: "closed" }));
    const { sync } = build();
    const result = await sync.import("acme", { repository: "acme/agent", numbers: [1, 2] }, actor);

    expect(result.created).toHaveLength(2);
    const [open, closed] = result.created;
    expect(open).toMatchObject({ status: "todo", description: "steps", labels: ["bug"] });
    expect(open?.github).toMatchObject({ repository: "acme/agent", number: 1, sync: { pull: true, push: false } });
    expect(closed?.status).toBe("done");
    // A scorecard we do not have would poison every regression comparison downstream.
    expect(closed?.resolution?.scorecardId).toBeUndefined();
    expect(closed?.resolution?.note).toContain("Closed on GitHub");
  });

  it("is idempotent — re-importing a number the workspace already holds is a skip, not a duplicate", async () => {
    remote.issues.set(1, remoteIssue({ number: 1 }));
    const { sync } = build();
    await sync.import("acme", { repository: "acme/agent", numbers: [1] }, actor);
    const again = await sync.import("acme", { repository: "acme/agent", numbers: [1] }, actor);
    expect(again.created).toEqual([]);
    expect(again.skipped).toEqual([{ number: 1, reason: "already_imported" }]);
    expect(store.byId.size).toBe(1);
  });

  it("refuses pull requests and hides already-imported issues from the candidate list", async () => {
    remote.issues.set(1, remoteIssue({ number: 1 }));
    remote.issues.set(2, remoteIssue({ number: 2, isPullRequest: true }));
    const { sync } = build();
    expect((await sync.importCandidates("acme", { repository: "acme/agent" })).map((i) => i.number)).toEqual([1]);

    await sync.import("acme", { repository: "acme/agent", numbers: [1] }, actor);
    expect(await sync.importCandidates("acme", { repository: "acme/agent" })).toEqual([]);

    const pr = await sync.import("acme", { repository: "acme/agent", numbers: [2] }, actor);
    expect(pr.skipped).toEqual([{ number: 2, reason: "pull_request" }]);
  });

  it("caps the imported comment thread", async () => {
    remote.issues.set(1, remoteIssue({ number: 1 }));
    remote.comments = Array.from({ length: 3 }, (_, i) => ({
      author: "kim",
      body: `c${i}`,
      createdAt: NOW,
      url: "u",
    }));
    const { sync } = build();
    const [created] = (await sync.import("acme", { repository: "acme/agent", numbers: [1] }, actor)).created;
    expect(created?.github?.comments).toHaveLength(3);
  });
});

describe("GithubIssueSync — pull", () => {
  let store: FakeIssueStore;
  let remote: RemoteState;

  function build() {
    const issues = new IssueService({ store, teams: teamAllocator, now: () => NOW });
    const sync = new GithubIssueSync({
      store,
      issues,
      teams: teamAllocator,
      tokens: { tokenForRepository: async () => ({ token: "tok" }) },
      writers: fakeWriters(remote),
      now: () => NOW,
    });
    return { issues, sync };
  }

  beforeEach(() => {
    store = new FakeIssueStore();
    remote = { issues: new Map(), comments: [], patched: [], postedComments: [], listCalls: [] };
  });

  async function imported(over: Partial<GithubIssue> & { number: number } = { number: 1 }) {
    remote.issues.set(over.number, remoteIssue(over));
    const { sync, issues } = build();
    const [record] = (await sync.import("acme", { repository: "acme/agent", numbers: [over.number] }, actor)).created;
    if (!record) throw new Error("import failed");
    return { sync, issues, record };
  }

  it("takes the remote's title/body/labels and re-watermarks with the REMOTE clock", async () => {
    const { sync, record } = await imported({ number: 1 });
    remote.issues.set(
      1,
      remoteIssue({
        number: 1,
        title: "renamed",
        body: "new body",
        labels: ["p1"],
        updatedAt: "2026-08-01T00:00:00.000Z",
      }),
    );
    const pulled = await sync.pullIssue("acme", record.id, actor);
    expect(pulled).toMatchObject({ title: "renamed", description: "new body", labels: ["p1"] });
    expect(pulled.github?.syncedAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("suppresses the echo of our own push — an unchanged remote is a no-op", async () => {
    const { sync, record } = await imported({ number: 1 });
    const before = record.updatedAt;
    const pulled = await sync.pullIssue("acme", record.id, actor);
    expect(pulled.updatedAt).toBe(before);
    expect(pulled.title).toBe(record.title);
  });

  it("reconciles a remote close through the NORMAL resolve transition, so the fact is indistinguishable", async () => {
    const { sync, record } = await imported({ number: 1 });
    remote.issues.set(1, remoteIssue({ number: 1, state: "closed", updatedAt: "2026-08-01T00:00:00.000Z" }));
    const pulled = await sync.pullIssue("acme", record.id, actor);
    expect(pulled.status).toBe("done");
    expect(pulled.resolution?.note).toContain("Closed on GitHub");
    const statusFact = store.events.find((e) => e.kind === "issue.status_changed");
    expect(statusFact?.payload).toMatchObject({ to: "done", cause: "github_sync" });
  });

  it("reconciles a remote reopen back to todo", async () => {
    const { sync, issues, record } = await imported({ number: 1 });
    await issues.setStatus("acme", record.id, { status: "done", resolution: { note: "fixed" } }, actor);
    remote.issues.set(1, remoteIssue({ number: 1, state: "open", updatedAt: "2026-08-01T00:00:00.000Z" }));
    const pulled = await sync.pullIssue("acme", record.id, actor);
    expect(pulled.status).toBe("todo");
  });

  it("bulk-pulls a repo with ONE incremental list call and skips issues absent from the page", async () => {
    const { sync } = await imported({ number: 1 });
    remote.issues.set(2, remoteIssue({ number: 2 }));
    await sync.import("acme", { repository: "acme/agent", numbers: [2] }, actor);
    remote.listCalls.length = 0;
    // Only #1 changed since the watermark.
    remote.issues.set(1, remoteIssue({ number: 1, title: "moved", updatedAt: "2026-08-02T00:00:00.000Z" }));

    const outcomes = await sync.pullRepository("acme", { repository: "acme/agent" }, actor);
    expect(remote.listCalls).toHaveLength(1);
    expect(remote.listCalls[0]?.state).toBe("all");
    expect(remote.listCalls[0]?.since).toBeDefined();
    expect(outcomes.find((o) => o.number === 1)?.changed).toBe(true);
    expect(outcomes.find((o) => o.number === 2)?.changed).toBe(false);
  });
});

describe("GithubIssueSync — push", () => {
  let store: FakeIssueStore;
  let remote: RemoteState;

  function build() {
    const issues = new IssueService({ store, teams: teamAllocator, now: () => NOW });
    const sync = new GithubIssueSync({
      store,
      issues,
      teams: teamAllocator,
      tokens: { tokenForRepository: async () => ({ token: "tok" }) },
      writers: fakeWriters(remote),
      webBaseUrl: "https://everdict.example.com",
      now: () => NOW,
    });
    return { issues, sync };
  }

  beforeEach(() => {
    store = new FakeIssueStore();
    remote = { issues: new Map(), comments: [], patched: [], postedComments: [], listCalls: [] };
    remote.issues.set(1, remoteIssue({ number: 1 }));
  });

  async function pushEnabled() {
    const { sync, issues } = build();
    const [record] = (
      await sync.import("acme", { repository: "acme/agent", numbers: [1], sync: { pull: true, push: true } }, actor)
    ).created;
    if (!record) throw new Error("import failed");
    return { sync, issues, record };
  }

  it("closes the remote and explains why, linking back to the everdict issue", async () => {
    const { sync, issues, record } = await pushEnabled();
    const resolved = await issues.setStatus(
      "acme",
      record.id,
      { status: "done", resolution: { scorecardId: "sc-1", note: "green" } },
      actor,
    );
    await sync.pushStatus(resolved, actor);

    expect(remote.patched).toEqual([{ number: 1, state: "closed" }]);
    const comment = remote.postedComments[0]?.body ?? "";
    expect(comment).toContain("Resolved in everdict");
    expect(comment).toContain("green");
    expect(comment).toContain("sc-1");
    expect(comment).toContain("https://everdict.example.com/acme/issues/");
    expect((await store.get("acme", record.id))?.github?.state).toBe("closed");
  });

  it("names the regression when a fallen resolution reopens the remote", async () => {
    const { sync, issues, record } = await pushEnabled();
    await issues.setStatus("acme", record.id, { status: "done", resolution: { scorecardId: "sc-1" } }, actor);
    const regressed = await issues.setStatus("acme", record.id, { status: "regressed", cause: "regression" }, actor);
    await sync.pushStatus(regressed, actor);
    expect(remote.postedComments.at(-1)?.body).toContain("regressed");
  });

  it("is best-effort — a remote failure annotates the record and never disturbs the committed status", async () => {
    const { sync, issues, record } = await pushEnabled();
    const resolved = await issues.setStatus("acme", record.id, { status: "done", resolution: {} }, actor);
    remote.failWrites = "403 from GitHub";
    await sync.pushStatus(resolved, actor);

    const after = await store.get("acme", record.id);
    expect(after?.status).toBe("done"); // the local transition stands
    expect(after?.github?.lastError).toMatchObject({ op: "push", message: expect.stringContaining("403") });
    expect(after?.history.at(-1)?.event).toBe("github_push_failed");
  });

  it("stays silent when the copy has push disabled", async () => {
    const { sync, issues } = build();
    const [record] = (await sync.import("acme", { repository: "acme/agent", numbers: [1] }, actor)).created;
    if (!record) throw new Error("import failed");
    const resolved = await issues.setStatus("acme", record.id, { status: "done", resolution: {} }, actor);
    await sync.pushStatus(resolved, actor);
    expect(remote.patched).toEqual([]);
    expect(remote.postedComments).toEqual([]);
  });
});
