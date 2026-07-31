import { GithubIssueSync, IssueService, RunService } from "@everdict/application-control";
import type { GithubIssue, GithubRepoWriter, GithubRepoWriterFactory } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryIssueStore, InMemoryRunStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

// The tracker's GitHub surface at the transport level: the feature gate, the authz, and that a repo the
// workspace App is not installed on surfaces as the service's error rather than a 500.

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in tracker tests");
  },
};

const H = { "x-everdict-tenant": "acme" };

function remoteIssue(number: number, over: Partial<GithubIssue> = {}): GithubIssue {
  return {
    number,
    title: `remote issue ${number}`,
    state: "open",
    author: "kim",
    url: `https://github.com/acme/agent/issues/${number}`,
    isPullRequest: false,
    updatedAt: "2026-07-31T10:00:00.000Z",
    labels: [],
    ...over,
  };
}

function build(opts: { issues?: GithubIssue[]; tokenError?: Error } = {}) {
  const remote = opts.issues ?? [remoteIssue(1), remoteIssue(2, { isPullRequest: true })];
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
    async listIssues() {
      return remote;
    },
    async getIssue(_repo, number) {
      const found = remote.find((i) => i.number === number);
      if (!found) throw new Error("missing");
      return found;
    },
    async updateIssue() {},
    async listIssueComments() {
      return [];
    },
    async createIssue() {
      throw new Error("unused");
    },
    async createIssueComment() {
      return { url: "u" };
    },
  };
  const writers: GithubRepoWriterFactory = { for: () => writer };
  const store = new InMemoryIssueStore();
  const issueService = new IssueService({ store });
  const issueSync = new GithubIssueSync({
    store,
    issues: issueService,
    tokens: {
      tokenForRepository: async () => {
        if (opts.tokenError) throw opts.tokenError;
        return { token: "tok" };
      },
    },
    writers,
  });
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    issueService,
    issueSync,
  });
  return { app, store };
}

describe("issue GitHub sync routes", () => {
  it("lists importable issues, excluding pull requests and anything already imported", async () => {
    const { app } = build();
    const candidates = await app.inject({
      method: "GET",
      url: "/issues/import/candidates?repository=acme/agent",
      headers: H,
    });
    expect(candidates.statusCode).toBe(200);
    expect(candidates.json().map((c: { number: number }) => c.number)).toEqual([1]);

    const imported = await app.inject({
      method: "POST",
      url: "/issues/import",
      headers: H,
      payload: { repository: "acme/agent", numbers: [1] },
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().created).toHaveLength(1);
    expect(imported.json().created[0].github).toMatchObject({ number: 1, sync: { pull: true, push: false } });

    const after = await app.inject({
      method: "GET",
      url: "/issues/import/candidates?repository=acme/agent",
      headers: H,
    });
    expect(after.json()).toEqual([]);
  });

  it("re-importing is a skip, not a duplicate", async () => {
    const { app, store } = build();
    const payload = { repository: "acme/agent", numbers: [1] };
    await app.inject({ method: "POST", url: "/issues/import", headers: H, payload });
    const again = await app.inject({ method: "POST", url: "/issues/import", headers: H, payload });
    expect(again.json().skipped).toEqual([{ number: 1, reason: "already_imported" }]);
    expect(await store.list("acme")).toHaveLength(1);
  });

  it("toggles the sync direction and detaches the copy while keeping the local issue", async () => {
    const { app } = build();
    const created = (
      await app.inject({
        method: "POST",
        url: "/issues/import",
        headers: H,
        payload: { repository: "acme/agent", numbers: [1] },
      })
    ).json().created[0];

    const toggled = await app.inject({
      method: "PUT",
      url: `/issues/${created.id}/github`,
      headers: H,
      payload: { pull: true, push: true },
    });
    expect(toggled.json().github.sync).toEqual({ pull: true, push: true });

    const detached = await app.inject({ method: "DELETE", url: `/issues/${created.id}/github`, headers: H });
    expect(detached.statusCode).toBe(200);
    expect(detached.json().github).toBeUndefined();
    expect(detached.json().title).toBe("remote issue 1"); // the local issue survives the detach
  });

  it("bulk pull reports a per-issue outcome and is a no-op when nothing changed", async () => {
    const { app } = build();
    await app.inject({
      method: "POST",
      url: "/issues/import",
      headers: H,
      payload: { repository: "acme/agent", numbers: [1] },
    });
    const pulled = await app.inject({
      method: "POST",
      url: "/issues/sync",
      headers: H,
      payload: { repository: "acme/agent" },
    });
    expect(pulled.statusCode).toBe(200);
    expect(pulled.json()).toEqual([expect.objectContaining({ number: 1, changed: false })]);
  });

  it("refuses sync toggles on an issue that was never imported", async () => {
    const { app } = build();
    const local = await app.inject({ method: "POST", url: "/issues", headers: H, payload: { title: "hand-filed" } });
    const refused = await app.inject({
      method: "PUT",
      url: `/issues/${local.json().id}/github`,
      headers: H,
      payload: { pull: true, push: false },
    });
    expect(refused.statusCode).toBe(400);
  });

  it("validates the body and 404s when no GitHub App is composed", async () => {
    const { app } = build();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/issues/import",
          headers: H,
          payload: { repository: "acme/agent", numbers: [] },
        })
      ).statusCode,
    ).toBe(400);
    expect((await app.inject({ method: "GET", url: "/issues/import/candidates", headers: H })).statusCode).toBe(400);

    const bare = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
      issueService: new IssueService({ store: new InMemoryIssueStore() }),
    });
    expect(
      (await bare.inject({ method: "GET", url: "/issues/import/candidates?repository=acme/agent", headers: H }))
        .statusCode,
    ).toBe(404);
    await bare.close();
    await app.close();
  });
});
