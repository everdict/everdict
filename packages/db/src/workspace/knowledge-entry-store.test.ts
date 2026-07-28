import type { KnowledgeEntryRecord } from "@everdict/contracts";
import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../client.js";
import { InMemoryKnowledgeEntryStore, PgKnowledgeEntryStore } from "./knowledge-entry-store.js";

const rec = (
  id: string,
  tenant: string,
  createdBy: string,
  createdAt: string,
  visibility: "private" | "workspace" = "workspace",
): KnowledgeEntryRecord => ({
  id,
  tenant,
  kind: "finding",
  title: `${id} title`,
  body: "body",
  refs: [{ type: "harness", key: "web-agent", version: "2.1.0" }],
  evidence: [],
  status: "active",
  visibility,
  createdBy,
  createdAt,
  updatedAt: createdAt,
});

describe("InMemoryKnowledgeEntryStore", () => {
  it("list returns workspace entries + the caller's own private ones, newest first", async () => {
    const store = new InMemoryKnowledgeEntryStore();
    await store.create(rec("shared", "acme", "alice", "2026-07-01T00:00:00.000Z", "workspace"));
    await store.create(rec("alice-priv", "acme", "alice", "2026-07-03T00:00:00.000Z", "private"));
    await store.create(rec("bob-priv", "acme", "bob", "2026-07-04T00:00:00.000Z", "private")); // hidden from alice
    await store.create(rec("beta", "beta", "alice", "2026-07-05T00:00:00.000Z", "workspace")); // other workspace
    expect((await store.list("acme", "alice")).map((r) => r.id)).toEqual(["alice-priv", "shared"]);
  });

  it("get/update/remove can't touch another workspace (no existence leak)", async () => {
    const store = new InMemoryKnowledgeEntryStore();
    await store.create(rec("a", "acme", "alice", "2026-07-01T00:00:00.000Z"));
    expect(await store.get("beta", "a")).toBeUndefined();
    expect(await store.update("beta", "a", { title: "x" })).toBeUndefined();
    await store.remove("beta", "a"); // no-op
    expect(await store.get("acme", "a")).toBeDefined();
  });

  it("update merges the patch but keeps id/tenant immutable", async () => {
    const store = new InMemoryKnowledgeEntryStore();
    await store.create(rec("a", "acme", "alice", "2026-07-01T00:00:00.000Z"));
    const updated = await store.update("acme", "a", {
      status: "deprecated",
      verifiedAt: "2026-07-28T00:00:00.000Z",
      tenant: "evil",
      id: "evil",
    });
    expect(updated).toMatchObject({ id: "a", tenant: "acme", status: "deprecated" });
  });
});

describe("PgKnowledgeEntryStore", () => {
  it("round-trips refs/evidence jsonb and null-able supersedes/verified_at through the row mapping", async () => {
    const record = { ...rec("kn1", "acme", "alice", "2026-07-01T00:00:00.000Z"), supersedes: "kn0" };
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.startsWith("SELECT")) {
        return {
          rows: [
            {
              id: "kn1",
              tenant: "acme",
              kind: "finding",
              title: "kn1 title",
              body: "body",
              refs: [{ type: "harness", key: "web-agent", version: "2.1.0" }],
              evidence: [],
              status: "active",
              supersedes: "kn0",
              visibility: "workspace",
              created_by: "alice",
              created_at: new Date("2026-07-01T00:00:00.000Z"),
              updated_at: new Date("2026-07-01T00:00:00.000Z"),
              verified_at: null,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const store = new PgKnowledgeEntryStore({ query } as unknown as SqlClient);
    await store.create(record);
    const insert = query.mock.calls[0];
    expect(insert?.[0]).toContain("INSERT INTO everdict_knowledge_entries");
    expect(insert?.[1]?.[5]).toBe(JSON.stringify(record.refs)); // refs as jsonb text
    expect(insert?.[1]?.[13]).toBeNull(); // verified_at

    const loaded = await store.get("acme", "kn1");
    expect(loaded?.supersedes).toBe("kn0");
    expect(loaded?.refs[0]?.version).toBe("2.1.0");
    expect(loaded?.verifiedAt).toBeUndefined();
  });
});
