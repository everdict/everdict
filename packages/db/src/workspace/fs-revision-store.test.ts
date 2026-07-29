import { ConflictError, type FsRevision } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SqlClient } from "../client.js";
import { InMemoryFsRevisionStore, PgFsRevisionStore } from "./fs-revision-store.js";

const revision = (over: Partial<FsRevision> = {}): FsRevision => ({
  tenant: "acme",
  path: "reports/q3.md",
  revision: 1,
  size: 12,
  contentType: "text/markdown; charset=utf-8",
  hash: "abc123",
  actor: { kind: "member", subject: "user-a" },
  createdAt: "2026-07-29T00:00:00.000Z",
  ...over,
});

// Captures the SQL a Pg store issues and replays canned rows — the house pattern for Pg logic (no live DB).
function fakeClient(rows: unknown[] = []): SqlClient & { calls: Array<{ text: string; params?: unknown[] }> } {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  return {
    calls,
    async query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }> {
      calls.push({ text, params });
      return { rows: rows as R[] };
    },
  };
}

describe("InMemoryFsRevisionStore", () => {
  it("refuses to publish a revision number that already exists", async () => {
    // Given a published revision 1
    const store = new InMemoryFsRevisionStore();
    await store.append(revision());
    // When another writer claims the same number
    const race = store.append(revision({ actor: { kind: "member", subject: "user-b" } }));
    // Then the ledger rejects it — the allocation is the uniqueness, not a hope
    await expect(race).rejects.toBeInstanceOf(ConflictError);
    expect(await store.head("acme", "reports/q3.md")).toMatchObject({ actor: { subject: "user-a" } });
  });

  it("lists a file's history newest first and honours the page cap", async () => {
    const store = new InMemoryFsRevisionStore();
    for (const n of [1, 2, 3]) await store.append(revision({ revision: n }));
    expect((await store.list("acme", "reports/q3.md")).map((r) => r.revision)).toEqual([3, 2, 1]);
    expect((await store.list("acme", "reports/q3.md", { limit: 2 })).map((r) => r.revision)).toEqual([3, 2]);
  });

  it("never leaks another workspace's history", async () => {
    const store = new InMemoryFsRevisionStore();
    await store.append(revision({ tenant: "acme" }));
    expect(await store.list("other", "reports/q3.md")).toEqual([]);
    expect(await store.get("other", "reports/q3.md", 1)).toBeUndefined();
  });

  it("carries history across a file rename and a directory move", async () => {
    // Given history under a directory
    const store = new InMemoryFsRevisionStore();
    await store.append(revision({ path: "drafts/a.md" }));
    await store.append(revision({ path: "drafts/sub/b.md" }));
    // When the file is renamed and then the whole directory moves
    await store.rename("acme", "drafts/a.md", "drafts/renamed.md");
    await store.rename("acme", "drafts", "reports");
    // Then every revision followed its file
    expect(await store.list("acme", "reports/renamed.md")).toHaveLength(1);
    expect(await store.list("acme", "reports/sub/b.md")).toHaveLength(1);
    expect(await store.list("acme", "drafts/renamed.md")).toEqual([]);
  });
});

describe("PgFsRevisionStore", () => {
  it("lets the primary key allocate the revision and reports a losing race", async () => {
    // Given an insert that hits the (tenant, path, revision) key
    const client = fakeClient([]); // ON CONFLICT DO NOTHING → no returned row
    const store = new PgFsRevisionStore(client);
    // When appending
    const append = store.append(revision());
    // Then it surfaces as a conflict, and the statement was the conflict-safe one
    await expect(append).rejects.toBeInstanceOf(ConflictError);
    expect(client.calls[0]?.text).toContain("INSERT INTO everdict_fs_revisions");
    expect(client.calls[0]?.text).toContain("ON CONFLICT (tenant, path, revision) DO NOTHING");
    expect(client.calls[0]?.params?.[6]).toBe(JSON.stringify({ kind: "member", subject: "user-a" }));
  });

  it("maps a row back to the record, coercing pg's bigint strings", async () => {
    const client = fakeClient([
      {
        tenant: "acme",
        path: "reports/q3.md",
        revision: "7",
        size: "4096",
        content_type: "text/markdown; charset=utf-8",
        hash: "abc123",
        actor: { kind: "agent", subject: "user-a", agentId: "analyst", onBehalfOf: "user-a" },
        message: "regenerated",
        restored_from: null,
        created_at: new Date("2026-07-29T00:00:00.000Z"),
      },
    ]);
    const head = await new PgFsRevisionStore(client).head("acme", "reports/q3.md");
    expect(head).toMatchObject({
      revision: 7,
      size: 4096,
      message: "regenerated",
      actor: { kind: "agent", agentId: "analyst" },
      createdAt: "2026-07-29T00:00:00.000Z",
    });
    expect(client.calls[0]?.text).toContain("ORDER BY revision DESC LIMIT 1");
  });

  it("rewrites both the exact path and its subtree on a move", async () => {
    const client = fakeClient();
    await new PgFsRevisionStore(client).rename("acme", "drafts", "reports");
    expect(client.calls[0]?.text).toContain("UPDATE everdict_fs_revisions");
    expect(client.calls[0]?.text).toContain("path LIKE $2 || '/%'");
    expect(client.calls[0]?.params).toEqual(["acme", "drafts", "reports"]);
  });
});
