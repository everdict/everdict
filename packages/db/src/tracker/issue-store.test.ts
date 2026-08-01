import type { OutboxEvent } from "@everdict/application-control";
import type { IssueRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { InMemoryIssueStore, PgIssueStore } from "./issue-store.js";

const issue = (over: Partial<IssueRecord>): IssueRecord => ({
  id: "iss-1",
  tenant: "acme",
  teamId: "team-eng",
  number: 1,
  identifier: "ENG-1",
  title: "Agent drops the tool result on retry",
  status: "todo",
  labels: [],
  links: [],
  history: [],
  createdBy: "dana",
  createdAt: "2026-07-31T00:00:00.000Z",
  updatedAt: "2026-07-31T00:00:00.000Z",
  ...over,
});

const event = (id: string): OutboxEvent => ({
  id,
  tenant: "acme",
  kind: "issue.created",
  subject: { type: "issue", id: "iss-1" },
  payload: {},
  message: "Issue filed",
  createdAt: "2026-07-31T00:00:00.000Z",
});

describe("InMemoryIssueStore", () => {
  it("lists tenant-scoped issues newest-activity first and filters by status and project", async () => {
    const store = new InMemoryIssueStore();
    await store.create(issue({ id: "a", updatedAt: "2026-07-31T01:00:00.000Z", projectId: "prj-1" }));
    await store.create(issue({ id: "b", status: "done", updatedAt: "2026-07-31T02:00:00.000Z" }));
    await store.create(issue({ id: "other", tenant: "globex" }));
    expect((await store.list("acme")).map((r) => r.id)).toEqual(["b", "a"]);
    expect((await store.list("acme", { status: "done" })).map((r) => r.id)).toEqual(["b"]);
    expect((await store.list("acme", { projectId: "prj-1" })).map((r) => r.id)).toEqual(["a"]);
    expect(await store.get("acme", "other")).toBeUndefined(); // another workspace's id does not resolve
  });

  it("finds issues by the capability they link — id-level, so a version bump still matches", async () => {
    const store = new InMemoryIssueStore();
    await store.create(
      issue({
        id: "a",
        links: [
          { type: "harness", id: "web-agent", version: "1.0.0", addedBy: "dana", addedAt: "2026-07-31T00:00:00.000Z" },
        ],
      }),
    );
    await store.create(issue({ id: "b" }));
    expect((await store.list("acme", { link: { type: "harness", id: "web-agent" } })).map((r) => r.id)).toEqual(["a"]);
    expect(await store.list("acme", { link: { type: "harness", id: "other" } })).toEqual([]);
  });

  it("matches an imported copy by its remote identity and narrows to the pull-enabled working set", async () => {
    const store = new InMemoryIssueStore();
    const github = {
      repository: "acme/agent",
      number: 42,
      url: "https://github.com/acme/agent/issues/42",
      state: "open" as const,
      sync: { pull: true, push: false },
      comments: [],
    };
    await store.create(issue({ id: "a", github }));
    await store.create(issue({ id: "b", github: { ...github, number: 43, sync: { pull: false, push: false } } }));
    expect((await store.getByGithub("acme", "acme/agent", 42))?.id).toBe("a");
    expect(await store.getByGithub("acme", "acme/agent", 99)).toBeUndefined();
    expect((await store.list("acme", { syncPull: true })).map((r) => r.id)).toEqual(["a"]);
  });

  it("resolves the addressable identifier within the tenant only", async () => {
    const store = new InMemoryIssueStore();
    await store.create(issue({ id: "a", identifier: "ENG-7" }));
    await store.create(issue({ id: "other", tenant: "globex", identifier: "ENG-7" }));
    expect((await store.getByIdentifier("acme", "ENG-7"))?.id).toBe("a");
    expect((await store.getByIdentifier("globex", "ENG-7"))?.id).toBe("other"); // same name, different workspace
    expect(await store.getByIdentifier("acme", "ENG-8")).toBeUndefined();
  });

  it("persists the outbox facts alongside the write", async () => {
    const store = new InMemoryIssueStore();
    await store.create(issue({ id: "a" }), [event("ev-1")]);
    await store.update("acme", "a", { status: "in_progress" }, [event("ev-2")]);
    expect(store.emittedEvents().map((e) => e.id)).toEqual(["ev-1", "ev-2"]);
  });

  it("update and remove only reach the tenant's own row", async () => {
    const store = new InMemoryIssueStore();
    await store.create(issue({ id: "a" }));
    expect(await store.update("globex", "a", { status: "done" })).toBeUndefined();
    await store.remove("globex", "a");
    expect(await store.get("acme", "a")).toBeDefined();
    await store.remove("acme", "a");
    expect(await store.get("acme", "a")).toBeUndefined();
  });
});

// Pg logic against a fake SqlClient (no live DB — see skill `testing`): assert the parameterized SQL + row mapping.
describe("PgIssueStore", () => {
  function fakeClient(rows: unknown[] = []) {
    const queries: { text: string; params: unknown[] }[] = [];
    const client: SqlClient = {
      query: async <R>(text: string, params: unknown[] = []) => {
        queries.push({ text, params });
        return { rows: rows as R[] };
      },
    };
    return { queries, client };
  }

  it("writes the issue and its facts in ONE statement (the E0 same-tx outbox)", async () => {
    const { client, queries } = fakeClient();
    await new PgIssueStore(client).create(issue({ id: "a" }), [event("ev-1")]);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain("WITH ins AS (INSERT INTO everdict_issues");
    expect(queries[0]?.text).toContain("INSERT INTO everdict_platform_events");
    expect(queries[0]?.text).toContain("WHERE EXISTS (SELECT 1 FROM ins)");
  });

  it("narrows list in SQL — status, project, link containment and the pull-enabled partial predicate", async () => {
    const { client, queries } = fakeClient();
    const store = new PgIssueStore(client);
    await store.list("acme", { status: "regressed", projectId: "prj-1", limit: 10 });
    expect(queries[0]?.text).toContain("status = $2");
    expect(queries[0]?.text).toContain("project_id = $3");
    expect(queries[0]?.text).toContain("ORDER BY updated_at DESC");
    expect(queries[0]?.params).toEqual(["acme", "regressed", "prj-1", 10]);

    await store.list("acme", { link: { type: "dataset", id: "regression-suite" }, syncPull: true });
    expect(queries[1]?.text).toContain("links @> $2::jsonb");
    expect(queries[1]?.text).toContain("(github->'sync'->>'pull') = 'true'");
    expect(queries[1]?.params?.[1]).toBe(JSON.stringify([{ type: "dataset", id: "regression-suite" }]));
  });

  it("matches the remote identity including a NULL host (github.com)", async () => {
    const { client, queries } = fakeClient();
    await new PgIssueStore(client).getByGithub("acme", "acme/agent", 42);
    expect(queries[0]?.text).toContain("(github->>'number')::int = $3");
    expect(queries[0]?.text).toContain("IS NOT DISTINCT FROM $4");
    expect(queries[0]?.params).toEqual(["acme", "acme/agent", 42, null]);
  });

  it("looks the identifier up on the (tenant, identifier) unique index", async () => {
    const { client, queries } = fakeClient();
    await new PgIssueStore(client).getByIdentifier("acme", "ENG-7");
    expect(queries[0]?.text).toContain("WHERE tenant=$1 AND identifier=$2");
    expect(queries[0]?.params).toEqual(["acme", "ENG-7"]);
  });

  it("maps rows back through the record schema (jsonb columns, null → absent)", async () => {
    const { client } = fakeClient([
      {
        id: "a",
        tenant: "acme",
        team_id: "team-eng",
        number: 12,
        identifier: "ENG-12",
        title: "t",
        description: null,
        status: "regressed",
        project_id: "prj-1",
        assignee: null,
        labels: ["bug"],
        links: [{ type: "harness", id: "web-agent", addedBy: "dana", addedAt: "2026-07-31T00:00:00.000Z" }],
        resolution: { scorecardId: "sc-1", by: "dana", at: "2026-07-31T00:00:00.000Z" },
        github: null,
        history: [{ at: "2026-07-31T00:00:00.000Z", by: "dana", event: "created" }],
        created_by: "dana",
        origin: null,
        created_at: "2026-07-31T00:00:00.000Z",
        updated_at: "2026-07-31T00:00:00.000Z",
      },
    ]);
    const record = await new PgIssueStore(client).get("acme", "a");
    expect(record?.status).toBe("regressed");
    expect(record?.labels).toEqual(["bug"]);
    expect(record?.resolution?.scorecardId).toBe("sc-1");
    expect(record?.history).toHaveLength(1);
    expect(record?.description).toBeUndefined();
    expect(record?.github).toBeUndefined();
  });
});
