import { randomBytes } from "node:crypto";
import { ConflictError, type FsEntry, type FsRevision, normalizeFsPath } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { generateAgentToken, generateInviteToken, generateKey } from "../credential/credentials.js";
import type { FsRevisionStore } from "../ports/fs-revision-store.js";
import type { FsFile, FsWriteOptions, WorkspaceFs } from "../ports/workspace-fs.js";
import { assertNoSecretsInMemory, isMemoryPath } from "./memory-secret-guard.js";
import { RevisionedWorkspaceFs, memberActor } from "./revisioned-workspace-fs.js";

// ── THE GUARD AND THE FILESYSTEM MUST AGREE ON WHAT "IN memory/" MEANS ────────────────────────────────
//
// `assertNoSecretsInMemory` runs in the revision decorator, which is the one seam every writer goes through —
// the right place. But the decorator sits ABOVE path canonicalization: both real adapters (InMemoryWorkspaceFs
// and S3WorkspaceFs) call `normalizeFsPath` on every operation, and that function deliberately ACCEPTS "./",
// repeated slashes and surrounding whitespace, folding them away. The guard's own predicate stripped a leading
// "/" and nothing else.
//
// Two predicates for one question, so they diverged: `./memory/notes.md` is not "in memory/" to the guard and
// IS `memory/notes.md` to the filesystem. The door does not close the gap either — `write-fs-file.ts` types the
// field as `z.string().min(1).max(600)`, not `FsPathSchema`, so a non-canonical path arrives intact.
//
// These tests drive the decorator over a filesystem double that normalizes EXACTLY as the real adapters do.
// That fidelity is the whole test: the package's existing `FakeFs` keys by the raw path, and over that double
// the bypass is invisible — the bytes land at a key nobody would call a memory file.
class NormalizingFs implements WorkspaceFs {
  readonly files = new Map<string, Uint8Array>();
  async list(): Promise<FsEntry[]> {
    return [];
  }
  async stat(tenant: string, path: string): Promise<FsEntry | undefined> {
    const data = this.files.get(`${tenant} ${normalizeFsPath(path)}`);
    return data ? entryOf(normalizeFsPath(path), data) : undefined;
  }
  async read(tenant: string, path: string): Promise<FsFile | undefined> {
    const data = this.files.get(`${tenant} ${normalizeFsPath(path)}`);
    return data ? { entry: entryOf(normalizeFsPath(path), data), data } : undefined;
  }
  async write(tenant: string, path: string, data: Uint8Array, _c?: string, _o?: FsWriteOptions): Promise<FsEntry> {
    const p = normalizeFsPath(path);
    this.files.set(`${tenant} ${p}`, data);
    return entryOf(p, data);
  }
  async mkdir(): Promise<FsEntry> {
    throw new Error("unused");
  }
  async remove(): Promise<number> {
    return 0;
  }
  async move(): Promise<FsEntry> {
    throw new Error("unused");
  }
  async usage(): Promise<{ bytes: number; files: number }> {
    return { bytes: 0, files: 0 };
  }
  async readRevisionBlob(): Promise<FsFile | undefined> {
    return undefined;
  }
  async writeRevisionBlob(): Promise<void> {}
  async removeRevisionBlobs(): Promise<number> {
    return 0;
  }
}

function entryOf(path: string, data: Uint8Array): FsEntry {
  return {
    path,
    name: path.split("/").pop() ?? path,
    kind: "file",
    size: data.byteLength,
    contentType: "text/markdown; charset=utf-8",
    modifiedAt: "2026-08-30T00:00:00.000Z",
  };
}

// A faithful ledger: `append` is the allocation, so it REFUSES a duplicate (tenant, path, revision) the way both
// production implementations do. A double that always accepts would turn the decorator's lost-race branch into
// dead code under test — see rule `testing` on doubles that cannot answer what the real one answers.
class Revisions implements FsRevisionStore {
  readonly rows = new Map<string, FsRevision>();
  async append(record: FsRevision): Promise<void> {
    const key = `${record.tenant} ${record.path} ${record.revision}`;
    if (this.rows.has(key)) throw new ConflictError("CONFLICT", { path: record.path }, "revision already published");
    this.rows.set(key, record);
  }
  async head(tenant: string, path: string): Promise<FsRevision | undefined> {
    return [...this.rows.values()]
      .filter((r) => r.tenant === tenant && r.path === path)
      .sort((a, b) => b.revision - a.revision)[0];
  }
  async list(): Promise<FsRevision[]> {
    return [];
  }
  async get(): Promise<FsRevision | undefined> {
    return undefined;
  }
  async rename(): Promise<void> {}
  async usage(): Promise<{ revisions: number; bytes: number }> {
    return { revisions: this.rows.size, bytes: 0 };
  }
  async purge(): Promise<number> {
    return 0;
  }
}

const KEY = "ak_0123456789abcdefghijklmn";

function decorated(): { fs: RevisionedWorkspaceFs; inner: NormalizingFs } {
  const inner = new NormalizingFs();
  return { fs: new RevisionedWorkspaceFs(inner, new Revisions()), inner };
}

describe("a credential may not reach memory/ by a path the guard and the filesystem read differently", () => {
  // The canonical spelling is refused — this is the property the guard already had, pinned so the repair
  // below cannot be mistaken for the whole of it.
  it("refuses the canonical memory path", async () => {
    const { fs, inner } = decorated();
    await expect(
      fs.write("acme", "memory/notes.md", new TextEncoder().encode(`token: ${KEY}`), undefined, {
        actor: memberActor("member-1"),
      }),
    ).rejects.toThrow(/never store credentials/);
    expect(inner.files.size).toBe(0);
  });

  // Every spelling `normalizeFsPath` folds into `memory/…`. Before the fix each of these wrote the credential
  // into the workspace-shared memory area, which is replayed into future agent contexts forever.
  const disguises = ["./memory/notes.md", "/memory/notes.md", "memory//notes.md", "  memory/notes.md  "];
  for (const path of disguises) {
    it(`refuses ${JSON.stringify(path)}, which the filesystem stores as ${normalizeFsPath(path)}`, async () => {
      const { fs, inner } = decorated();
      await expect(
        fs.write("acme", path, new TextEncoder().encode(`token: ${KEY}`), undefined, {
          actor: memberActor("member-1"),
        }),
      ).rejects.toThrow(/never store credentials/);
      // The assertion that matters is the WORLD, not the refusal: a guard that throws after the bytes landed
      // has refused nothing.
      expect([...inner.files.keys()]).toEqual([]);
    });
  }

  // A member's own memory area is inside the same tree (`memory/members/<slug>/`), so it inherits the guard —
  // including through the non-canonical spellings.
  it("covers a member's own memory subtree", async () => {
    const { fs, inner } = decorated();
    await expect(
      fs.write("acme", "./memory/members/u-1/prefs.md", new TextEncoder().encode(KEY), undefined, {
        actor: memberActor("member-1"),
      }),
    ).rejects.toThrow(/never store credentials/);
    expect(inner.files.size).toBe(0);
  });

  // Precision over recall is the guard's stated trade: a token-shaped string OUTSIDE memory/ is legitimate
  // data (a fixture, a doc about token formats) and must still be writable.
  it("leaves a token-shaped string outside memory/ alone", async () => {
    const { fs, inner } = decorated();
    await fs.write("acme", "docs/token-formats.md", new TextEncoder().encode(KEY), undefined, {
      actor: memberActor("member-1"),
    });
    expect(inner.files.has("acme docs/token-formats.md")).toBe(true);
  });

  // A path the filesystem will REFUSE outright cannot be proved safe, so it is scanned rather than waved
  // through. Nothing is written either way; what this pins is that the guard does not treat "I could not
  // parse this" as "this is not a memory file".
  it("scans a path it cannot canonicalize instead of exempting it", () => {
    // Chosen so only the unparseable arm can answer: it does not start with `memory`, so the prefix test says
    // no, and `normalizeFsPath` throws on the ".." rather than folding it. Nothing lands under this spelling
    // either way — the adapter refuses it — so what this pins is the direction the guard fails in.
    expect(() => normalizeFsPath("docs/../memory/notes.md")).toThrow();
    expect(isMemoryPath("docs/../memory/notes.md")).toBe(true);
    expect(() => assertNoSecretsInMemory("docs/../memory/notes.md", new TextEncoder().encode(KEY))).toThrow(
      /never store credentials/,
    );
  });
});

// ── THE DETECTOR IS DRIVEN BY THE MINTERS, NOT BY HAND-WRITTEN LOOK-ALIKES ───────────────────────────
//
// Both halves of the gap this closes are invisible to a fixture somebody types: a hand-written `ak_` string
// is alphanumeric, so it matched the old pattern, and a prefix nobody listed is a prefix nobody writes a
// fixture for. Minting from the real functions is what asks the question the guard is actually answering.
describe("every credential this repo mints is one the memory guard recognises", () => {
  // `rnr_` is minted by @everdict/db (`generateRunnerToken`) and application-control may not import it —
  // that is the layer direction. Its shape is the family's, so it is minted here the same way, and the
  // family list in the guard is what keeps the two spellings honest.
  const runnerToken = (): string => `rnr_${randomBytes(24).toString("base64url")}`;
  const minters: readonly { what: string; mint: () => string }[] = [
    { what: "a workspace API key", mint: generateKey },
    { what: "a workspace invite token", mint: generateInviteToken },
    { what: "an agent execution token", mint: generateAgentToken },
    { what: "a runner pairing token", mint: runnerToken },
  ];

  for (const { what, mint } of minters) {
    // 200 samples, because the defect this replaces was PROBABILISTIC: base64url draws from 64 symbols and
    // the old pattern accepted 62 of them, so a single sample passed 48% of the time and the suite would
    // have been flaky rather than red. A miss rate is not something one fixture can see.
    it(`refuses ${what} in a memory file, whichever characters it draws`, () => {
      const missed = Array.from({ length: 200 }, mint).filter((token) => {
        try {
          assertNoSecretsInMemory("memory/notes.md", new TextEncoder().encode(`the token is ${token}`));
          return true;
        } catch {
          return false;
        }
      });
      expect(missed).toEqual([]);
    });
  }

  // The same tokens outside memory/ stay writable — the guard's stated trade is precision over recall, and
  // widening the alphabet must not turn it into a workspace-wide credential scanner.
  it("still leaves those tokens alone outside memory/", () => {
    for (const { mint } of minters) {
      expect(() => assertNoSecretsInMemory("docs/example.md", new TextEncoder().encode(mint()))).not.toThrow();
    }
  });

  // Prose that merely mentions a prefix is not a credential. `{16,}` is the floor that separates them, and
  // widening the character class must not lower it.
  it("does not fire on prose that names a prefix without carrying a secret", () => {
    for (const harmless of ["see ak_ prefixed keys", "the agt_ family", "rnr_ tokens are shown once", "inv_"]) {
      expect(() => assertNoSecretsInMemory("memory/notes.md", new TextEncoder().encode(harmless))).not.toThrow();
    }
  });
});
