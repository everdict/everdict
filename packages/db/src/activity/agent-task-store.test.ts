import type { AgentTaskRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { InMemoryAgentTaskStore, PgAgentTaskStore } from "./agent-task-store.js";

const task = (over: Partial<AgentTaskRecord>): AgentTaskRecord => ({
  id: "t-1",
  tenant: "acme",
  subject: "Run the baseline",
  status: "pending",
  blockedBy: [],
  createdBy: "u-1",
  createdAt: "2026-07-31T00:00:00.000Z",
  updatedAt: "2026-07-31T00:00:00.000Z",
  ...over,
});

describe("InMemoryAgentTaskStore", () => {
  it("lists tenant-scoped tasks newest-activity first, with an optional status filter", async () => {
    const store = new InMemoryAgentTaskStore();
    await store.create(task({ id: "a", updatedAt: "2026-07-31T01:00:00.000Z" }));
    await store.create(task({ id: "b", status: "completed", updatedAt: "2026-07-31T02:00:00.000Z" }));
    await store.create(task({ id: "other", tenant: "globex" }));
    expect((await store.list("acme")).map((t) => t.id)).toEqual(["b", "a"]);
    expect((await store.list("acme", { status: "pending" })).map((t) => t.id)).toEqual(["a"]);
    expect(await store.get("acme", "other")).toBeUndefined(); // another workspace's id does not resolve
  });

  it("update patches in place and remove deletes only the tenant's own row", async () => {
    const store = new InMemoryAgentTaskStore();
    await store.create(task({ id: "a" }));
    const updated = await store.update("acme", "a", { status: "in_progress", owner: "u-2" });
    expect(updated?.status).toBe("in_progress");
    expect(updated?.owner).toBe("u-2");
    await store.remove("globex", "a"); // wrong tenant — no-op
    expect(await store.get("acme", "a")).toBeDefined();
    await store.remove("acme", "a");
    expect(await store.get("acme", "a")).toBeUndefined();
  });
});

// Pg logic against a fake SqlClient (no live DB — see skill `testing`): assert the parameterized SQL + row mapping.
describe("PgAgentTaskStore", () => {
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

  it("create writes the full row and list orders by activity with the status filter parameterized", async () => {
    const { client, queries } = fakeClient();
    const store = new PgAgentTaskStore(client);
    await store.create(task({ id: "a", origin: { agentId: "bot", conversationId: "c1" } }));
    expect(queries[0]?.text).toContain("INSERT INTO everdict_agent_tasks");
    expect(queries[0]?.params?.[0]).toBe("a");
    expect(queries[0]?.params?.[8]).toBe(JSON.stringify({ agentId: "bot", conversationId: "c1" }));
    await store.list("acme", { status: "pending", limit: 5 });
    expect(queries[1]?.text).toContain("WHERE tenant = $1 AND status = $2");
    expect(queries[1]?.text).toContain("ORDER BY updated_at DESC");
    expect(queries[1]?.params).toEqual(["acme", "pending", 5]);
  });

  it("maps rows back through the record schema (jsonb blockedBy/origin, null → absent)", async () => {
    const { client } = fakeClient([
      {
        id: "a",
        tenant: "acme",
        subject: "s",
        description: null,
        status: "pending",
        owner: null,
        blocked_by: ["t-0"],
        created_by: "u-1",
        origin: { agentId: "bot" },
        created_at: "2026-07-31T00:00:00.000Z",
        updated_at: "2026-07-31T00:00:00.000Z",
      },
    ]);
    const store = new PgAgentTaskStore(client);
    const record = await store.get("acme", "a");
    expect(record?.blockedBy).toEqual(["t-0"]);
    expect(record?.origin).toEqual({ agentId: "bot" });
    expect(record?.description).toBeUndefined();
    expect(record?.owner).toBeUndefined();
  });
});
