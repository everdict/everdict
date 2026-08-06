import { type FsEntry, NotFoundError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { FsRevisionStore } from "../ports/fs-revision-store.js";
import type { FsFile, WorkspaceFs } from "../ports/workspace-fs.js";
import { FsService } from "./fs-service.js";
import { MemberScopedWorkspaceFs } from "./member-scoped-workspace-fs.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

// A tree holding the shared memory area and two members' own areas.
class TreeFs implements WorkspaceFs {
  readonly files = new Map<string, Uint8Array>([
    ["memory/MEMORY.md", utf8("- [Cadence](cadence.md) — Friday reports")],
    ["memory/cadence.md", utf8("The team ships on Friday.")],
    ["memory/members/alice/MEMORY.md", utf8("- [Tone](tone.md) — Alice likes terse answers")],
    ["memory/members/alice/tone.md", utf8("Alice likes terse answers.")],
    ["memory/members/bob/MEMORY.md", utf8("- [Hours](hours.md) — Bob works mornings")],
    ["reports/q3.md", utf8("the quarter")],
  ]);
  async list(_tenant: string, dir: string): Promise<FsEntry[]> {
    const prefix = dir === "" ? "" : `${dir}/`;
    const names = new Set<string>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const head = rest.split("/")[0];
      if (head !== undefined) names.add(head);
    }
    return [...names].map((name) => {
      const path = `${prefix}${name}`;
      return { path, name, kind: this.files.has(path) ? "file" : "dir" };
    });
  }
  async stat(_tenant: string, path: string): Promise<FsEntry | undefined> {
    return this.files.has(path) ? { path, name: path.split("/").pop() ?? path, kind: "file" } : undefined;
  }
  async read(tenant: string, path: string): Promise<FsFile | undefined> {
    const data = this.files.get(path);
    const entry = await this.stat(tenant, path);
    return data && entry ? { entry, data } : undefined;
  }
  async write(_tenant: string, path: string, data: Uint8Array): Promise<FsEntry> {
    this.files.set(path, data);
    return { path, name: path.split("/").pop() ?? path, kind: "file" };
  }
  async mkdir(_tenant: string, path: string): Promise<FsEntry> {
    return { path, name: path, kind: "dir" };
  }
  async remove(_tenant: string, path: string, opts?: { recursive?: boolean }): Promise<number> {
    let n = 0;
    for (const key of [...this.files.keys()]) {
      if (key === path || (opts?.recursive === true && key.startsWith(`${path}/`))) {
        this.files.delete(key);
        n++;
      }
    }
    return n;
  }
  async move(tenant: string, from: string, to: string): Promise<FsEntry> {
    const data = this.files.get(from);
    if (!data) throw new NotFoundError("NOT_FOUND", { path: from }, "missing");
    this.files.delete(from);
    this.files.set(to, data);
    const entry = await this.stat(tenant, to);
    if (!entry) throw new NotFoundError("NOT_FOUND", { path: to }, "missing");
    return entry;
  }
  async writeRevisionBlob(): Promise<void> {}
  async readRevisionBlob(): Promise<FsFile | undefined> {
    return undefined;
  }
  async removeRevisionBlobs(): Promise<number> {
    return 0;
  }
}

describe("MemberScopedWorkspaceFs", () => {
  it("shows a member the shared tree plus their own memory, and no one else's", async () => {
    // Given Alice looking at the workspace
    const fs = new MemberScopedWorkspaceFs(new TreeFs(), "alice");
    // Then the shared tree is untouched — a workspace is one filesystem, and that is the point of it
    expect((await fs.list("acme", "")).map((e) => e.name).sort()).toEqual(["memory", "reports"]);
    expect((await fs.read("acme", "memory/cadence.md"))?.data).toBeDefined();
    // …the member root lists ONLY her (the listing is the leak: a name alone says who wrote memory here)
    expect((await fs.list("acme", "memory/members")).map((e) => e.name)).toEqual(["alice"]);
    // …her own memory reads
    expect((await fs.read("acme", "memory/members/alice/tone.md"))?.data).toBeDefined();
    // …and Bob's does not exist for her — NOT FOUND, never FORBIDDEN
    expect(await fs.read("acme", "memory/members/bob/MEMORY.md")).toBeUndefined();
    expect(await fs.stat("acme", "memory/members/bob/MEMORY.md")).toBeUndefined();
  });

  it("refuses every WRITE into another member's area, whichever door it comes to", async () => {
    const inner = new TreeFs();
    const fs = new MemberScopedWorkspaceFs(inner, "alice");
    await expect(fs.write("acme", "memory/members/bob/planted.md", utf8("x"))).rejects.toThrow(NotFoundError);
    await expect(fs.remove("acme", "memory/members/bob/MEMORY.md")).rejects.toThrow(NotFoundError);
    await expect(fs.move("acme", "memory/members/alice/tone.md", "memory/members/bob/tone.md")).rejects.toThrow(
      NotFoundError,
    );
    await expect(fs.move("acme", "memory/members/bob/MEMORY.md", "reports/stolen.md")).rejects.toThrow(NotFoundError);
    expect(inner.files.has("memory/members/bob/MEMORY.md")).toBe(true);
    expect(inner.files.has("reports/stolen.md")).toBe(false);
  });

  it("refuses a recursive delete that would reach the member areas from above", async () => {
    // Given a member deleting a directory they ARE allowed to name
    const inner = new TreeFs();
    const fs = new MemberScopedWorkspaceFs(inner, "alice");
    // When the delete is recursive and sits above the member areas
    await expect(fs.remove("acme", "memory", { recursive: true })).rejects.toThrow(NotFoundError);
    await expect(fs.remove("acme", "", { recursive: true })).rejects.toThrow(NotFoundError);
    // Then everyone's memory survives — the scope must not be walkable through a parent
    expect(inner.files.has("memory/members/bob/MEMORY.md")).toBe(true);
    // …while their OWN area deletes recursively as normal
    expect(await fs.remove("acme", "memory/members/alice", { recursive: true })).toBe(2);
  });

  it("gives a caller who is nobody the shared tree and NO member area (forgetting an identity must hide)", async () => {
    const fs = new MemberScopedWorkspaceFs(new TreeFs(), undefined);
    expect(await fs.read("acme", "memory/cadence.md")).toBeDefined();
    expect((await fs.list("acme", "memory/members")).length).toBe(0);
    expect(await fs.read("acme", "memory/members/alice/tone.md")).toBeUndefined();
  });
});

describe("FsService.forMember", () => {
  it("scopes SEARCH — the read that would otherwise grep every member's memory", async () => {
    // Given a term that appears in the shared area and in both members' memory
    const service = new FsService(new TreeFs());
    // When Alice searches the whole tree
    const mine = await service.forMember("alice").search("acme", { pattern: "s" });
    const paths = mine.matches.map((m) => m.path);
    // Then she sees the shared hits and her own, and nothing of Bob's
    expect(paths).toContain("memory/cadence.md");
    expect(paths).toContain("memory/members/alice/tone.md");
    expect(paths.some((p) => p.startsWith("memory/members/bob/"))).toBe(false);
    // …and the unscoped service (content projections, operator paths) still sees everything
    const all = (await service.search("acme", { pattern: "s" })).matches.map((m) => m.path);
    expect(all.some((p) => p.startsWith("memory/members/bob/"))).toBe(true);
  });

  it("scopes the REVISION surfaces, which read the ledger instead of the filesystem", async () => {
    // Given a history the scoped port cannot cover (it goes to the ledger, not to storage)
    const ledger: FsRevisionStore = {
      async append() {},
      async list() {
        return [];
      },
      async head() {
        return undefined;
      },
      async get() {
        return undefined;
      },
      async rename() {},
      async usage() {
        return { revisions: 0, bytes: 0 };
      },
      async purge() {
        return 0;
      },
    };
    const alice = new FsService(new TreeFs(), ledger).forMember("alice");
    // Then another member's history is not readable, and neither is a revision's content
    await expect(alice.history("acme", "memory/members/bob/MEMORY.md")).rejects.toThrow(NotFoundError);
    await expect(alice.readRevision("acme", "memory/members/bob/MEMORY.md", 1)).rejects.toThrow(NotFoundError);
    await expect(alice.diffRevisions("acme", "memory/members/bob/MEMORY.md", 1)).rejects.toThrow(NotFoundError);
    // …while her own history is served normally (empty here — the point is that it does not refuse)
    expect(await alice.history("acme", "memory/members/alice/MEMORY.md")).toEqual([]);
  });
});
