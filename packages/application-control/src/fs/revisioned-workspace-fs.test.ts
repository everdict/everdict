import { ConflictError, type FsEntry, type FsRevision } from "@everdict/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import type { FsRevisionStore } from "../ports/fs-revision-store.js";
import type { EmitPlatformEventInput } from "../ports/platform-event-emitter.js";
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

  // The memory secret guard sits on the decorator because every writer — the HTTP route, the agent's write_file,
  // the turn-end extractor, a content projection — publishes through this one instance. It used to sit in
  // FsService, which is only ONE of them.
  describe("the memory secret guard", () => {
    // Low-entropy fixtures on purpose: they match OUR conservative patterns but not gitleaks' rules (which want
    // real-shaped tokens), so the repo's own secret scan stays quiet about its regression tests.
    const fakeGithubToken = `ghp_${"x".repeat(24)}`;
    const fakeWorkspaceKey = `ak_${"a".repeat(18)}`;

    it("refuses a credential-looking token in a memory file, naming what it found and publishing nothing", async () => {
      // When a write into memory/ carries a token
      await expect(
        fs.write("acme", "memory/github-setup.md", utf8(`Use ${fakeGithubToken} to clone.`)),
      ).rejects.toThrow(/never store credentials.*GitHub token/);
      await expect(fs.write("acme", "memory/keys.md", utf8(fakeWorkspaceKey))).rejects.toThrow(/workspace API key/);
      // Then nothing reached the filesystem OR the ledger — a refused write is not a revision
      expect(inner.files.size).toBe(0);
      expect(await ledger.head("acme", "memory/github-setup.md")).toBeUndefined();
    });

    it("guards a writer that never goes through FsService — the reason the check moved here", async () => {
      // Given a service holding the WorkspaceFs port directly (content projections and task outputs do)
      const port: WorkspaceFs = fs;
      await expect(port.write("acme", "memory/notes.md", utf8(fakeWorkspaceKey))).rejects.toThrow(/credentials/);
    });

    it("guards a MOVE into memory/ — the way around a write-only check", async () => {
      // Given a token sitting somewhere the guard allows it
      await fs.write("acme", "scratch/setup.md", utf8(`Use ${fakeGithubToken} to clone.`));
      // When it is renamed into the memory area
      await expect(fs.move("acme", "scratch/setup.md", "memory/setup.md")).rejects.toThrow(/GitHub token/);
      // Then the move did not happen — the file is still at its original path
      expect(inner.files.has("acme scratch/setup.md")).toBe(true);
      // …and moving WITHIN memory/, or out of it, is untouched
      await fs.write("acme", "memory/cadence.md", utf8("Friday reports."));
      await fs.move("acme", "memory/cadence.md", "memory/rituals.md");
      expect(inner.files.has("acme memory/rituals.md")).toBe(true);
    });

    it("guards ONLY memory/, and skips bytes that are not text", async () => {
      // The same content elsewhere on the tree is a normal write (a fixture, a doc about token formats)
      await fs.write("acme", "notes/github-setup.md", utf8(fakeGithubToken));
      expect(inner.files.has("acme notes/github-setup.md")).toBe(true);
      // A binary body under memory/ decodes to nothing a credential scan can read, so it publishes
      await fs.write("acme", "memory/diagram.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]));
      expect(inner.files.has("acme memory/diagram.png")).toBe(true);
      // …and ordinary memory prose is never in the way
      await fs.write("acme", "memory/cadence.md", utf8("Reference the GitHub secret by NAME, not value."));
      expect(inner.files.has("acme memory/cadence.md")).toBe(true);
    });
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
    // Then we are told. (This comment used to end "rather than overwriting the rival's publish" — a claim the
    // test did not check and the code did not honour until arch-review 114; the two cases below check it.)
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

  // ── THE REFUSAL CAME AFTER THE BYTES (arch-review 114) ──────────────────────────────────────────
  //
  // The two tests above assert that a lost race is REPORTED — "we are told, rather than overwriting the
  // rival's publish". The second half of that sentence was never checked, and it was false: the blob was
  // written at the computed revision BEFORE `revisions.append` decided who owns that number, so the loser had
  // already overwritten the winner's bytes by the time it was told. `writeRevisionBlob` is a plain put at
  // `(path, revision)` — a key two racing writers compute identically — and the port calls its result "the
  // immutable per-revision copy".
  //
  // The result is worse than losing a write: the ledger row for that revision names the WINNER (their hash,
  // their actor, their message) while the bytes behind it are the LOSER's. A history a member opens a year
  // later attributes one person's content to another, and the winner's content is gone.
  //
  // This is rule `protocol`'s named law — a refusal after an irreversible write is not a refusal — so the
  // assertion is about the WORLD, not about the throw: what does that revision actually hold afterwards.
  it("does not leave its bytes at a revision another writer won", async () => {
    // Given a rival that claims revision 1 between our head read and our append
    ledger.claimNext = 1;
    const write = fs.write("acme", "new.md", utf8("mine"), undefined, {
      actor: memberActor("user-a"),
      baseRevision: 0,
    });
    await expect(write).rejects.toBeInstanceOf(ConflictError);

    // Then revision 1 belongs to the rival — row AND bytes. Before the fix the row said "rival" and the blob
    // said "mine", which is the misattribution this asserts against.
    const row = await ledger.get("acme", "new.md", 1);
    expect(row?.actor).toMatchObject({ kind: "member", subject: "rival" });
    const blob = await inner.readRevisionBlob("acme", "new.md", 1);
    expect(
      blob === undefined ? undefined : new TextDecoder().decode(blob.data),
      "the refused write left its bytes under the rival's revision",
    ).not.toBe("mine");
  });

  // The same law on the blind path, where the loser does not even learn it lost: it takes the next number and
  // reports success, so nothing anywhere would ever surface that it had trampled the rival's revision.
  it("does not leave its bytes at a revision it lost, even when it silently retries", async () => {
    ledger.claimNext = 1;
    const entry = await fs.write("acme", "log.md", utf8("mine"), undefined, { actor: memberActor("user-a") });
    expect(entry.revision).toBe(2); // the blind writer took the next number, as before

    const first = await inner.readRevisionBlob("acme", "log.md", 1);
    expect(
      first === undefined ? undefined : new TextDecoder().decode(first.data),
      "the retrying writer left its bytes under the revision the rival published",
    ).not.toBe("mine");
    // …and its own revision holds its own bytes.
    const second = await inner.readRevisionBlob("acme", "log.md", 2);
    expect(new TextDecoder().decode(second?.data ?? new Uint8Array())).toBe("mine");
  });

  // The failure mode the reordering CREATES, stated rather than discovered later: a blob write that fails
  // after the number is claimed leaves a revision the ledger lists and cannot serve. That is the trade — an
  // absent revision is visible and the caller's write fails, where the old order served the WRONG bytes and
  // told nobody. Rule `protocol` asks for the replaced failure to be named when a change swaps one for
  // another, so it is named here and pinned.
  it("fails the write, rather than reporting success, when the bytes cannot be stored", async () => {
    const stubborn = new FakeFs();
    stubborn.writeRevisionBlob = async () => {
      throw new Error("object store unreachable");
    };
    const guarded = new RevisionedWorkspaceFs(stubborn, ledger, () => "2026-07-29T00:00:00.000Z");
    await expect(
      guarded.write("acme", "notes.md", utf8("v1"), undefined, { actor: memberActor("user-a") }),
    ).rejects.toThrow(/unreachable/);
    // The head content was never published either — a file whose bytes could not be stored must not appear
    // to have changed.
    expect(stubborn.files.get("acme notes.md")).toBeUndefined();
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

  it("serves the published bytes when a crash left the visible file behind the ledger", async () => {
    // Given a publish whose LAST step never landed: the ledger and the blob say revision 2, the visible file
    // still holds revision 1's bytes (the write sequence is blob → ledger → head object).
    await fs.write("acme", "notes.md", utf8("v1"), undefined, { actor: memberActor("user-a") });
    await fs.writeRevisionBlob("acme", "notes.md", 2, utf8("v2 published"), "text/markdown; charset=utf-8");
    await ledger.append({
      tenant: "acme",
      path: "notes.md",
      revision: 2,
      size: utf8("v2 published").byteLength,
      contentType: "text/markdown; charset=utf-8",
      hash: "x",
      actor: memberActor("user-a"),
      createdAt: "2026-07-29T00:00:00.000Z",
    });
    // When the file is read
    const file = await fs.read("acme", "notes.md");
    // Then the reader gets the PUBLISHED content — never stale bytes wearing the new revision's number
    expect(new TextDecoder().decode(file?.data)).toBe("v2 published");
    expect(file?.entry.revision).toBe(2);
    // …and the visible file was repaired, so the next reader costs nothing extra
    expect(new TextDecoder().decode(inner.files.get("acme notes.md")?.data)).toBe("v2 published");
  });

  it("does not touch a file whose bytes already match its published revision", async () => {
    await fs.write("acme", "notes.md", utf8("v1"), undefined, { actor: memberActor("user-a") });
    const before = inner.files.get("acme notes.md");
    const file = await fs.read("acme", "notes.md");
    expect(new TextDecoder().decode(file?.data)).toBe("v1");
    expect(inner.files.get("acme notes.md")).toBe(before); // same object — no rewrite
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

  describe("file.published fact (E2) — a publish is a transition, so it emits", () => {
    it("a member publish emits file.published with the revision; an agent publish stamps the loop guard's causedBy", async () => {
      const emitted: EmitPlatformEventInput[] = [];
      const evented = new RevisionedWorkspaceFs(inner, ledger, () => "2026-07-29T00:00:00.000Z", {
        async emit(input) {
          emitted.push(input);
          return undefined;
        },
      });

      await evented.write("acme", "reports/q3.md", utf8("draft"), undefined, { actor: memberActor("user-a") });
      expect(emitted[0]).toMatchObject({
        workspace: "acme",
        kind: "file.published",
        subject: { type: "file", id: "reports/q3.md" },
        actor: "user-a",
        payload: { path: "reports/q3.md", revision: 1, actorKind: "member" },
      });
      expect(emitted[0]).not.toHaveProperty("causedBy"); // a member publish has no causal chain

      await evented.write("acme", "data/out.csv", utf8("a,b"), undefined, {
        actor: { kind: "agent", subject: "user-a", agentId: "analyst", conversationId: "sess-9", onBehalfOf: "user-a" },
      });
      // The agent's own writes carry the loop guard's key — a folder-watching agent never wakes on itself.
      expect(emitted[1]).toMatchObject({
        kind: "file.published",
        causedBy: "agent:analyst:sess-9",
        payload: { actorKind: "agent", agentId: "analyst" },
      });
    });

    it("a refused optimistic write (409) emits nothing — no revision was published", async () => {
      const emitted: unknown[] = [];
      const evented = new RevisionedWorkspaceFs(inner, ledger, () => "2026-07-29T00:00:00.000Z", {
        async emit(input) {
          emitted.push(input);
          return undefined;
        },
      });
      await evented.write("acme", "notes.md", utf8("v1"), undefined, { actor: memberActor("user-a") });
      await expect(
        evented.write("acme", "notes.md", utf8("stale"), undefined, { actor: memberActor("user-b"), baseRevision: 0 }),
      ).rejects.toThrow(ConflictError);
      expect(emitted).toHaveLength(1); // only the successful publish emitted
    });
  });
});
