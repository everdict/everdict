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
  formerIdentifiers: [],
  title: "Agent drops the tool result on retry",
  status: "todo",
  priority: "none",
  inTriage: false,
  labelIds: [],
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

  it("pages the list projection on (updatedAt, id) — every issue seen exactly once across the pages", async () => {
    const store = new InMemoryIssueStore();
    // Two share an updatedAt: the tie is what a cursor on the timestamp ALONE would drop or repeat.
    await store.create(issue({ id: "a", updatedAt: "2026-07-31T03:00:00.000Z" }));
    await store.create(issue({ id: "b", updatedAt: "2026-07-31T02:00:00.000Z" }));
    await store.create(issue({ id: "c", updatedAt: "2026-07-31T02:00:00.000Z" }));
    await store.create(issue({ id: "d", updatedAt: "2026-07-31T01:00:00.000Z" }));

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listSummaries("acme", { limit: 2, ...(cursor !== undefined ? { cursor } : {}) });
      seen.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(seen).toEqual(["a", "c", "b", "d"]);
  });

  it("projects a list row down to what a row draws — no description, no history, links as a count", async () => {
    const store = new InMemoryIssueStore();
    await store.create(
      issue({
        id: "a",
        description: "a long body nobody renders in a list",
        history: [{ at: "2026-07-31T00:00:00.000Z", by: "dana", event: "created" }],
        links: [
          { type: "harness", id: "web-agent", addedBy: "dana", addedAt: "2026-07-31T00:00:00.000Z" },
          { type: "dataset", id: "suite", addedBy: "dana", addedAt: "2026-07-31T00:00:00.000Z" },
        ],
        github: {
          repository: "acme/agent",
          number: 42,
          url: "https://github.com/acme/agent/issues/42",
          state: "open",
          sync: { pull: true, push: false },
          // The comment slice is the single heaviest thing on the record — a list row must never carry it.
          comments: [{ author: "dana", body: "x", createdAt: "2026-07-31T00:00:00.000Z", url: "u" }],
        },
      }),
    );
    const [row] = (await store.listSummaries("acme")).items;
    expect(row).toMatchObject({ id: "a", identifier: "ENG-1", linkCount: 2 });
    expect(row).not.toHaveProperty("description");
    expect(row).not.toHaveProperty("history");
    expect(row).not.toHaveProperty("links");
    // The GitHub copy survives as the marker a row actually shows: which repo, and whether it pulls.
    expect(row?.github).toEqual({ repository: "acme/agent", pull: true });
  });

  it("counts issues per team in one pass, with regressed counting as OPEN", async () => {
    const store = new InMemoryIssueStore();
    await store.create(issue({ id: "a", teamId: "eng", status: "todo" }));
    await store.create(issue({ id: "b", teamId: "eng", status: "regressed" }));
    await store.create(issue({ id: "c", teamId: "eng", status: "done" }));
    await store.create(issue({ id: "d", teamId: "eng", status: "cancelled" }));
    await store.create(issue({ id: "e", teamId: "mob", status: "todo" }));
    await store.create(issue({ id: "f", tenant: "globex", teamId: "eng", status: "todo" }));
    const counts = await store.countByTeam("acme");
    expect(counts.find((row) => row.teamId === "eng")).toEqual({ teamId: "eng", total: 4, open: 2 });
    expect(counts.find((row) => row.teamId === "mob")).toEqual({ teamId: "mob", total: 1, open: 1 });
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

  it("selects only the projected columns for a list page, and seeks with a row-value cursor", async () => {
    const { client, queries } = fakeClient();
    const store = new PgIssueStore(client);
    await store.listSummaries("acme", { status: "todo", limit: 2 });
    const sql = queries[0]?.text ?? "";
    // The whole point: the heavy columns are never read, so they are never shipped and never parsed.
    expect(sql).not.toContain("SELECT *");
    expect(sql).not.toMatch(/\bdescription\b/);
    expect(sql).not.toMatch(/\bhistory\b/);
    expect(sql).toContain("COALESCE(jsonb_array_length(links), 0) AS link_count");
    expect(sql).toContain("ORDER BY updated_at DESC, id DESC");
    expect(sql).toContain("LIMIT 3"); // size + 1 — the extra row is how "is there a next page" is answered

    await store.listSummaries("acme", {
      cursor: Buffer.from("2026-07-31T02:00:00.000Z|b", "utf8").toString("base64url"),
    });
    // A row-value comparison matching the ORDER BY, so the index seeks to the page instead of scanning past it.
    expect(queries[1]?.text).toContain("(updated_at, id) < ($2::timestamptz, $3)");
    expect(queries[1]?.params).toEqual(["acme", "2026-07-31T02:00:00.000Z", "b"]);
  });

  it("counts issues per team in ONE aggregate, taking the closed vocabulary as a parameter", async () => {
    const { client, queries } = fakeClient();
    await new PgIssueStore(client).countByTeam("acme");
    expect(queries).toHaveLength(1); // not one query per team
    expect(queries[0]?.text).toContain("count(*) FILTER (WHERE status <> ALL($2::text[]))");
    expect(queries[0]?.text).toContain("GROUP BY team_id");
    expect(queries[0]?.params).toEqual(["acme", ["done", "cancelled"]]);
  });

  it("maps a projected row to a summary — NULL github means no copy, not an empty one", async () => {
    const { client } = fakeClient([
      {
        id: "a",
        tenant: "acme",
        team_id: "team-eng",
        number: 12,
        identifier: "ENG-12",
        title: "t",
        status: "todo",
        priority: "none",
        inTriage: false,
        project_id: null,
        assignee: null,
        label_ids: ["lbl_bug"],
        resolution: null,
        created_by: "dana",
        created_at: "2026-07-31T00:00:00.000Z",
        updated_at: "2026-07-31T00:00:00.000Z",
        link_count: "3", // count(*) comes back as a string on some drivers
        github_repository: null,
        github_host: null,
        github_pull: false,
      },
    ]);
    const page = await new PgIssueStore(client).listSummaries("acme");
    expect(page.items[0]).toMatchObject({ identifier: "ENG-12", linkCount: 3, labelIds: ["lbl_bug"] });
    expect(page.items[0]?.github).toBeUndefined();
    expect(page.nextCursor).toBeUndefined(); // one row back for a 50-row page — nothing after it
  });

  it("matches the remote identity including a NULL host (github.com)", async () => {
    const { client, queries } = fakeClient();
    await new PgIssueStore(client).getByGithub("acme", "acme/agent", 42);
    expect(queries[0]?.text).toContain("(github->>'number')::int = $3");
    expect(queries[0]?.text).toContain("IS NOT DISTINCT FROM $4");
    expect(queries[0]?.params).toEqual(["acme", "acme/agent", 42, null]);
  });

  it("looks the identifier up on the unique index, falling back to the names the issue used to have", async () => {
    const { client, queries } = fakeClient();
    await new PgIssueStore(client).getByIdentifier("acme", "ENG-7");
    // Both spellings in one statement, current-first: a team move re-mints the identifier, and a link pasted
    // before the move still has to land on the issue it named.
    expect(queries[0]?.text).toContain("identifier=$2 OR former_identifiers @> $3::jsonb");
    expect(queries[0]?.text).toContain("ORDER BY (identifier=$2) DESC");
    expect(queries[0]?.params).toEqual(["acme", "ENG-7", JSON.stringify(["ENG-7"])]);
  });

  it("maps rows back through the record schema (jsonb columns, null → absent)", async () => {
    const { client } = fakeClient([
      {
        id: "a",
        tenant: "acme",
        team_id: "team-eng",
        number: 12,
        identifier: "ENG-12",
        formerIdentifiers: [],
        title: "t",
        description: null,
        status: "regressed",
        priority: "none",
        inTriage: false,
        project_id: "prj-1",
        assignee: null,
        label_ids: ["lbl_bug"],
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
    expect(record?.labelIds).toEqual(["lbl_bug"]);
    expect(record?.resolution?.scorecardId).toBe("sc-1");
    expect(record?.history).toHaveLength(1);
    expect(record?.description).toBeUndefined();
    expect(record?.github).toBeUndefined();
  });
});

describe("issue store — the planning fields and the sub-issue tree", () => {
  it("selects one parent's sub-issues, and `null` selects the top-level ones", async () => {
    const store = new InMemoryIssueStore();
    await store.create(issue({ id: "parent" }));
    await store.create(issue({ id: "child", parentId: "parent" }));
    await store.create(issue({ id: "loner" }));
    expect((await store.list("acme", { parentId: "parent" })).map((r) => r.id)).toEqual(["child"]);
    // `null` is "everything that is not somebody's sub-issue" — what a board shows so a child never appears twice.
    expect((await store.list("acme", { parentId: null })).map((r) => r.id).sort()).toEqual(["loner", "parent"]);
  });

  it("filters by priority", async () => {
    const store = new InMemoryIssueStore();
    await store.create(issue({ id: "a", priority: "urgent" }));
    await store.create(issue({ id: "b", priority: "low" }));
    expect((await store.list("acme", { priority: "urgent" })).map((r) => r.id)).toEqual(["a"]);
  });

  it("carries the planning fields into the LIST projection — a row draws all four", async () => {
    const store = new InMemoryIssueStore();
    await store.create(issue({ id: "a", priority: "high", estimate: 5, dueDate: "2026-08-31", parentId: "parent" }));
    const [row] = (await store.listSummaries("acme")).items;
    expect(row).toMatchObject({ priority: "high", estimate: 5, dueDate: "2026-08-31", parentId: "parent" });
  });

  // The Pg half needs its own fake client: the one above lives inside the other describe's scope.
  function pgClient() {
    const queries: { text: string; params?: unknown[] }[] = [];
    const client: SqlClient = {
      async query<T>(text: string, params?: unknown[]) {
        queries.push({ text, ...(params !== undefined ? { params } : {}) });
        return { rows: [] as T[] };
      },
    };
    return { client, queries };
  }

  it("writes the new columns on Postgres", async () => {
    const { client, queries } = pgClient();
    await new PgIssueStore(client).create(issue({ id: "a", priority: "urgent", estimate: 2, dueDate: "2026-08-31" }));
    expect(queries[0]?.text).toContain("priority");
    expect(queries[0]?.text).toContain("due_date");
    expect(queries[0]?.params).toContain("urgent");
  });

  it("narrows by parent in SQL — `null` becomes IS NULL, never an equality on the string 'null'", async () => {
    const { client, queries } = pgClient();
    await new PgIssueStore(client).list("acme", { parentId: null });
    expect(queries[0]?.text).toContain("parent_id IS NULL");
    await new PgIssueStore(client).list("acme", { parentId: "iss-1" });
    expect(queries.at(-1)?.params).toContain("iss-1");
  });
});
