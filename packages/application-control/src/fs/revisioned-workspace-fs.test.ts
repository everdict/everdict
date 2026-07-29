import { ConflictError, type FsEntry, type FsRevision } from "@everdict/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import type { FsRevisionStore } from "../ports/fs-revision-store.js";
import type { FsFile, FsWriteOptions, WorkspaceFs } from "../ports/workspace-fs.js";
import { RevisionedWorkspaceFs, memberActor } from "./revisioned-workspace-fs.js";

// A minimal filesystem + ledger pair for these tests (application-control cannot depend on @everdict/storage or
// @everdict/db — that would invert the layer direction), covering exactly what the decorator drives.
class FakeFs implements WorkspaceFs {
  readonly files = new Map<string, { data: Uint8Array; contentType: string }>();
  readonly blobs = new Map<string, { data: Uint8Array; contentType: string }>();
  async list(): Promise<FsEntry[]> {
    return [];
  }
  async stat(tenant: string, path: string): Promise<FsEntry | undefined> {
    const hit = this.files.get(`${tenant} ${path}`);
    return hit ? entryOf(path, hit.data, hit.contentType) : undefined;
  }
  async read(tenant: string, path: string): Promise<FsFile | undefined> {
    const hit = this.files.get(`${tenant} ${path}`);
    return hit ? { entry: entryOf(path, hit.data, hit.contentType), data: hit.data } : undefined;
  }
  async write(
    tenant: string,
    path: string,
    data: Uint8Array,
    contentType?: string,
    _opts?: FsWriteOptions,
  ): Promise<FsEntry> {
    const type = contentType ?? "text/plain; charset=utf-8";
    this.files.set(`${tenant} ${path}`, { data, contentType: type });
    return entryOf(path, data, type);
  }
  async mkdir(): Promise<FsEntry> {
    throw new Error("unused in these tests");
  }
  async remove(): Promise<number> {
    return 0;
  }
  async move(tenant: string, from: string, to: string): Promise<FsEntry> {
    const hit = this.files.get(`${tenant} ${from}`);
    if (!hit) throw new Error("missing");
    this.files.delete(`${tenant} ${from}`);
    this.files.set(`${tenant} ${to}`, hit);
    return entryOf(to, hit.data, hit.contentType);
  }
  async writeRevisionBlob(
    tenant: string,
    path: string,
    revision: number,
    data: Uint8Array,
    contentType: string,
  ): Promise<void> {
    this.blobs.set(`${tenant} ${path}@${revision}`, { data, contentType });
  }
  async readRevisionBlob(tenant: string, path: string, revision: number): Promise<FsFile | undefined> {
    const hit = this.blobs.get(`${tenant} ${path}@${revision}`);
    return hit ? { entry: entryOf(path, hit.data, hit.contentType, revision), data: hit.data } : undefined;
  }
  async removeRevisionBlobs(tenant: string): Promise<number> {
    const mine = [...this.blobs.keys()].filter((k) => k.startsWith(`${tenant} `));
    for (const k of mine) this.blobs.delete(k);
    return mine.length;
  }
}

function entryOf(path: string, data: Uint8Array, contentType: string, revision?: number): FsEntry {
  return {
    path,
    name: path.split("/").at(-1) ?? path,
    kind: "file",
    size: data.byteLength,
    contentType,
    ...(revision !== undefined ? { revision } : {}),
  };
}

// The ledger's ONLY hard guarantee: (tenant, path, revision) is unique, so a duplicate append is a lost race.
class FakeRevisionStore implements FsRevisionStore {
  readonly rows: FsRevision[] = [];
  // Set to hand the NEXT append a phantom race — the decorator must react as if another writer got there first.
  claimNext: number | undefined = undefined;
  async append(record: FsRevision): Promise<void> {
    if (this.claimNext === record.revision) {
      this.claimNext = undefined;
      this.rows.push({ ...record, actor: { kind: "member", subject: "rival" } }); // the rival's row wins the number
      throw new ConflictError("CONFLICT", { path: record.path }, "revision already published");
    }
    if (this.rows.some((r) => r.tenant === record.tenant && r.path === record.path && r.revision === record.revision)) {
      throw new ConflictError("CONFLICT", { path: record.path }, "revision already published");
    }
    this.rows.push(record);
  }
  async head(tenant: string, path: string): Promise<FsRevision | undefined> {
    return (await this.list(tenant, path))[0];
  }
  async list(tenant: string, path: string): Promise<FsRevision[]> {
    return this.rows.filter((r) => r.tenant === tenant && r.path === path).sort((a, b) => b.revision - a.revision);
  }
  async get(tenant: string, path: string, revision: number): Promise<FsRevision | undefined> {
    return this.rows.find((r) => r.tenant === tenant && r.path === path && r.revision === revision);
  }
  async rename(tenant: string, from: string, to: string): Promise<void> {
    for (const row of this.rows) {
      if (row.tenant !== tenant) continue;
      if (row.path === from) row.path = to;
      else if (row.path.startsWith(`${from}/`)) row.path = `${to}/${row.path.slice(from.length + 1)}`;
    }
  }
  async usage(tenant: string): Promise<{ revisions: number; bytes: number }> {
    const mine = this.rows.filter((r) => r.tenant === tenant);
    return { revisions: mine.length, bytes: mine.reduce((sum, r) => sum + r.size, 0) };
  }
  async purge(tenant: string): Promise<number> {
    const before = this.rows.length;
    for (let i = this.rows.length - 1; i >= 0; i--) if (this.rows[i]?.tenant === tenant) this.rows.splice(i, 1);
    return before - this.rows.length;
  }
}

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("RevisionedWorkspaceFs", () => {
  let inner: FakeFs;
  let ledger: FakeRevisionStore;
  let fs: RevisionedWorkspaceFs;

  beforeEach(() => {
    inner = new FakeFs();
    ledger = new FakeRevisionStore();
    fs = new RevisionedWorkspaceFs(inner, ledger, () => "2026-07-29T00:00:00.000Z");
  });

  it("publishes a numbered revision per write, recording who published it", async () => {
    // Given a member writing a file twice
    const first = await fs.write("acme", "reports/q3.md", utf8("draft"), undefined, {
      actor: memberActor("user-a"),
      message: "first cut",
    });
    const second = await fs.write("acme", "reports/q3.md", utf8("final"), undefined, {
      actor: memberActor("user-b"),
    });
    // Then each write is its own revision, attributed to its own author
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(await ledger.list("acme", "reports/q3.md")).toMatchObject([
      { revision: 2, actor: { subject: "user-b" } },
      { revision: 1, actor: { subject: "user-a" }, message: "first cut" },
    ]);
  });

  it("records an agent as the author, keeping the member who asked", async () => {
    // Given an agent writing on a member's behalf
    await fs.write("acme", "data/out.csv", utf8("a,b"), undefined, {
      actor: {
        kind: "agent",
        subject: "user-a",
        agentId: "analyst",
        agentName: "Analyst",
        conversationId: "sess-9",
        onBehalfOf: "user-a",
      },
    });
    // Then the ledger can answer both "which agent" and "for whom"
    expect(await ledger.head("acme", "data/out.csv")).toMatchObject({
      actor: { kind: "agent", agentId: "analyst", conversationId: "sess-9", onBehalfOf: "user-a" },
    });
  });

  it("keeps the revision content readable after later writes overwrote the file", async () => {
    await fs.write("acme", "notes.md", utf8("v1"), undefined, { actor: memberActor("user-a") });
    await fs.write("acme", "notes.md", utf8("v2"), undefined, { actor: memberActor("user-a") });
    const old = await fs.readRevisionBlob("acme", "notes.md", 1);
    expect(new TextDecoder().decode(old?.data)).toBe("v1");
  });

  it("refuses a write whose declared base revision is no longer the head", async () => {
    // Given two authors who both started from revision 1
    await fs.write("acme", "notes.md", utf8("v1"), undefined, { actor: memberActor("user-a") });
    await fs.write("acme", "notes.md", utf8("v2 by b"), undefined, {
      actor: memberActor("user-b"),
      baseRevision: 1,
    });
    // When the slower author publishes against the stale base
    const write = fs.write("acme", "notes.md", utf8("v2 by a"), undefined, {
      actor: memberActor("user-a"),
      baseRevision: 1,
    });
    // Then the write is refused with the head it lost to — never a silent overwrite
    await expect(write).rejects.toBeInstanceOf(ConflictError);
    expect(new TextDecoder().decode(inner.files.get("acme notes.md")?.data)).toBe("v2 by b");
    await expect(write).rejects.toMatchObject({ extra: { baseRevision: 1, headRevision: 2 } });
  });

  it("turns a lost allocation race into a conflict for a declared-base write", async () => {
    // Given a rival that claims revision 1 between our head read and our append
    ledger.claimNext = 1;
    // When we publish declaring "this file does not exist yet"
    const write = fs.write("acme", "new.md", utf8("mine"), undefined, {
      actor: memberActor("user-a"),
      baseRevision: 0,
    });
    // Then we are told, rather than overwriting the rival's publish
    await expect(write).rejects.toBeInstanceOf(ConflictError);
  });

  it("lets a blind write take the next number when it loses the race", async () => {
    // Given a rival claiming revision 1 mid-flight, and a writer that declared no base (e.g. an agent appending)
    ledger.claimNext = 1;
    const entry = await fs.write("acme", "log.md", utf8("mine"), undefined, { actor: memberActor("user-a") });
    // Then the write still lands — as revision 2, on top of the rival's
    expect(entry.revision).toBe(2);
    expect(await ledger.list("acme", "log.md")).toHaveLength(2);
  });

  it("carries a file's history along when it is moved", async () => {
    await fs.write("acme", "draft.md", utf8("v1"), undefined, { actor: memberActor("user-a") });
    await fs.move("acme", "draft.md", "reports/final.md");
    // Then the history followed the file — a rename is not a new file with a blank past
    expect(await ledger.list("acme", "draft.md")).toEqual([]);
    expect(await ledger.list("acme", "reports/final.md")).toMatchObject([{ revision: 1 }]);
    // And the next publish continues the numbering
    const next = await fs.write("acme", "reports/final.md", utf8("v2"), undefined, { actor: memberActor("user-a") });
    expect(next.revision).toBe(2);
  });

  it("reports the current revision on stat and read", async () => {
    await fs.write("acme", "notes.md", utf8("v1"), undefined, { actor: memberActor("user-a") });
    await fs.write("acme", "notes.md", utf8("v2"), undefined, { actor: memberActor("user-a") });
    expect((await fs.stat("acme", "notes.md"))?.revision).toBe(2);
    expect((await fs.read("acme", "notes.md"))?.entry.revision).toBe(2);
  });

  it("attributes a write with no actor to the system rather than to nobody", async () => {
    await fs.write("acme", "skills/s1/SKILL.md", utf8("body"));
    expect(await ledger.head("acme", "skills/s1/SKILL.md")).toMatchObject({ actor: { kind: "system" } });
  });
});
