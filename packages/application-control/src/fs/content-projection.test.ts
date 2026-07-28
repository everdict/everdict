import {
  ConflictError,
  type FsEntry,
  type KnowledgeEntryRecord,
  NotFoundError,
  type SkillRecord,
  UpstreamError,
} from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { KnowledgeEntryService } from "../knowledge/knowledge-entry-service.js";
import type { KnowledgeEntryStore } from "../ports/knowledge-entry-store.js";
import type { SkillStore } from "../ports/skill-store.js";
import type { FsFile, WorkspaceFs } from "../ports/workspace-fs.js";
import { SkillService } from "../skill/skill-service.js";
import { readSkillContent, writeSkillContent } from "./content-projection.js";

// Map-backed fakes for the two store ports (the real InMemory* impls live in @everdict/db, which application-control
// must not import — reverse layer direction).
class FakeSkillStore implements SkillStore {
  private readonly rows = new Map<string, SkillRecord>();
  async create(record: SkillRecord): Promise<void> {
    this.rows.set(`${record.tenant}/${record.id}`, record);
  }
  async get(tenant: string, id: string): Promise<SkillRecord | undefined> {
    return this.rows.get(`${tenant}/${id}`);
  }
  async list(tenant: string): Promise<SkillRecord[]> {
    return [...this.rows.values()].filter((r) => r.tenant === tenant);
  }
  async update(tenant: string, id: string, patch: Partial<SkillRecord>): Promise<SkillRecord | undefined> {
    const current = this.rows.get(`${tenant}/${id}`);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.rows.set(`${tenant}/${id}`, next);
    return next;
  }
  async remove(tenant: string, id: string): Promise<void> {
    this.rows.delete(`${tenant}/${id}`);
  }
}

class FakeKnowledgeEntryStore implements KnowledgeEntryStore {
  private readonly rows = new Map<string, KnowledgeEntryRecord>();
  async create(record: KnowledgeEntryRecord): Promise<void> {
    this.rows.set(`${record.tenant}/${record.id}`, record);
  }
  async get(tenant: string, id: string): Promise<KnowledgeEntryRecord | undefined> {
    return this.rows.get(`${tenant}/${id}`);
  }
  async list(tenant: string): Promise<KnowledgeEntryRecord[]> {
    return [...this.rows.values()].filter((r) => r.tenant === tenant);
  }
  async update(
    tenant: string,
    id: string,
    patch: Partial<KnowledgeEntryRecord>,
  ): Promise<KnowledgeEntryRecord | undefined> {
    const current = this.rows.get(`${tenant}/${id}`);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.rows.set(`${tenant}/${id}`, next);
    return next;
  }
  async remove(tenant: string, id: string): Promise<void> {
    this.rows.delete(`${tenant}/${id}`);
  }
}

// A minimal in-memory WorkspaceFs for these tests (application-control cannot depend on @everdict/storage — that
// would invert the layer direction). Covers exactly what the projection uses: write / read / list / remove.
class FakeFs implements WorkspaceFs {
  readonly files = new Map<string, { data: Uint8Array; contentType: string }>();
  private key(tenant: string, path: string) {
    return `${tenant} ${path.replace(/^\/+|\/+$/g, "")}`;
  }
  async list(tenant: string, dir: string): Promise<FsEntry[]> {
    const clean = dir.replace(/^\/+|\/+$/g, "");
    const base = clean === "" ? `${tenant} ` : `${tenant} ${clean}/`;
    const children = new Map<string, FsEntry>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(base)) continue;
      const rest = key.slice(base.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        children.set(rest, { path: clean === "" ? rest : `${clean}/${rest}`, name: rest, kind: "file" });
      } else {
        const name = rest.slice(0, slash);
        children.set(name, { path: clean === "" ? name : `${clean}/${name}`, name, kind: "dir" });
      }
    }
    return [...children.values()];
  }
  async stat(): Promise<FsEntry | undefined> {
    throw new Error("unused in these tests");
  }
  async read(tenant: string, path: string): Promise<FsFile | undefined> {
    const hit = this.files.get(this.key(tenant, path));
    if (!hit) return undefined;
    const name = path.split("/").at(-1) ?? path;
    return { entry: { path, name, kind: "file", size: hit.data.byteLength }, data: hit.data };
  }
  async write(tenant: string, path: string, data: Uint8Array, contentType?: string): Promise<FsEntry> {
    this.files.set(this.key(tenant, path), { data, contentType: contentType ?? "application/octet-stream" });
    const name = path.split("/").at(-1) ?? path;
    return { path, name, kind: "file", size: data.byteLength };
  }
  async mkdir(): Promise<FsEntry> {
    throw new Error("unused in these tests");
  }
  async remove(tenant: string, path: string, opts?: { recursive?: boolean }): Promise<number> {
    const exact = this.key(tenant, path);
    if (this.files.delete(exact)) return 1;
    const childKeys = [...this.files.keys()].filter((k) => k.startsWith(`${exact}/`));
    if (childKeys.length === 0) return 0;
    if (!opts?.recursive) throw new ConflictError("CONFLICT", { path }, "not empty");
    for (const k of childKeys) this.files.delete(k);
    return childKeys.length;
  }
  async move(): Promise<FsEntry> {
    throw new Error("unused in these tests");
  }
}

class BrokenReadFs extends FakeFs {
  override async read(): Promise<FsFile | undefined> {
    throw new UpstreamError("UPSTREAM_ERROR", {}, "object storage down");
  }
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const text = (d: Uint8Array | undefined) => (d ? new TextDecoder().decode(d) : undefined);

const ACTOR = { subject: "user-a", isAdmin: false };

const LEGACY = {
  tenant: "acme",
  name: "old",
  description: "d",
  files: [],
  refs: [],
  visibility: "workspace" as const,
  createdBy: "user-a",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("skill content on the workspace filesystem (SSOT projection)", () => {
  it("create projects SKILL.md + supporting files onto the filesystem, and get round-trips them", async () => {
    const fs = new FakeFs();
    const service = new SkillService({ store: new FakeSkillStore(), fs, newId: () => "sk1" });
    await service.create({
      tenant: "acme",
      createdBy: "user-a",
      name: "triage",
      description: "how to triage",
      instructions: "# Steps",
      files: [{ path: "references/checklist.md", content: "- check" }],
    });
    expect(text(fs.files.get("acme skills/sk1/SKILL.md")?.data)).toBe("# Steps");
    expect(text(fs.files.get("acme skills/sk1/files/references/checklist.md")?.data)).toBe("- check");
    const got = await service.get("acme", "sk1", "user-a");
    expect(got.instructions).toBe("# Steps");
    expect(got.files).toEqual([{ path: "references/checklist.md", content: "- check" }]);
  });

  it("an out-of-band filesystem edit WINS on get and re-syncs the DB replica", async () => {
    const fs = new FakeFs();
    const store = new FakeSkillStore();
    const service = new SkillService({ store, fs, newId: () => "sk1" });
    await service.create({ tenant: "acme", createdBy: "user-a", name: "n", description: "d", instructions: "old" });
    // someone edits skills/sk1/SKILL.md through the shell / the agent's write_file
    await fs.write("acme", "skills/sk1/SKILL.md", utf8("edited on the filesystem"));
    const got = await service.get("acme", "sk1", "user-a");
    expect(got.instructions).toBe("edited on the filesystem");
    expect((await store.get("acme", "sk1"))?.instructions).toBe("edited on the filesystem"); // replica re-synced
  });

  it("a legacy DB-only skill is lazily migrated onto the filesystem on first get", async () => {
    const fs = new FakeFs();
    const store = new FakeSkillStore();
    await store.create({ ...LEGACY, id: "legacy", instructions: "pre-filesystem body" });
    const service = new SkillService({ store, fs });
    const got = await service.get("acme", "legacy", "user-a");
    expect(got.instructions).toBe("pre-filesystem body");
    expect(text(fs.files.get("acme skills/legacy/SKILL.md")?.data)).toBe("pre-filesystem body");
  });

  it("update replaces the whole projection — a removed supporting file does not linger", async () => {
    const fs = new FakeFs();
    const service = new SkillService({ store: new FakeSkillStore(), fs, newId: () => "sk1" });
    await service.create({
      tenant: "acme",
      createdBy: "user-a",
      name: "n",
      description: "d",
      instructions: "b",
      files: [{ path: "a.md", content: "A" }],
    });
    await service.update("acme", "sk1", { files: [{ path: "b.md", content: "B" }] }, ACTOR);
    expect(fs.files.has("acme skills/sk1/files/a.md")).toBe(false);
    expect(text(fs.files.get("acme skills/sk1/files/b.md")?.data)).toBe("B");
    expect(text(fs.files.get("acme skills/sk1/SKILL.md")?.data)).toBe("b"); // untouched fields carry over
  });

  it("remove cleans the projection up", async () => {
    const fs = new FakeFs();
    const service = new SkillService({ store: new FakeSkillStore(), fs, newId: () => "sk1" });
    await service.create({ tenant: "acme", createdBy: "user-a", name: "n", description: "d", instructions: "b" });
    await service.remove("acme", "sk1", ACTOR);
    expect([...fs.files.keys()].some((k) => k.includes("skills/sk1"))).toBe(false);
  });

  it("a filesystem outage never breaks a read — the DB replica answers", async () => {
    const store = new FakeSkillStore();
    await store.create({ ...LEGACY, id: "s2", instructions: "still readable" });
    const service = new SkillService({ store, fs: new BrokenReadFs() });
    expect((await service.get("acme", "s2", "user-a")).instructions).toBe("still readable");
  });
});

describe("knowledge-entry bodies on the workspace filesystem", () => {
  it("create projects knowledge/<id>.md; an out-of-band edit wins on get and re-syncs the replica", async () => {
    const fs = new FakeFs();
    const store = new FakeKnowledgeEntryStore();
    const service = new KnowledgeEntryService({ store, fs, newId: () => "ke1" });
    await service.create({
      tenant: "acme",
      createdBy: "user-a",
      kind: "finding",
      title: "flaky logins",
      body: "observed on k8s",
    });
    expect(text(fs.files.get("acme knowledge/ke1.md")?.data)).toBe("observed on k8s");
    await fs.write("acme", "knowledge/ke1.md", utf8("refined observation"));
    const got = await service.get("acme", "ke1", "user-a");
    expect(got.body).toBe("refined observation");
    expect((await store.get("acme", "ke1"))?.body).toBe("refined observation");
  });

  it("a missing projection is lazily written back on get; remove deletes the body file", async () => {
    const fs = new FakeFs();
    const store = new FakeKnowledgeEntryStore();
    const service = new KnowledgeEntryService({ store, fs, newId: () => "ke1" });
    await service.create({ tenant: "acme", createdBy: "user-a", kind: "context", title: "t", body: "b" });
    await fs.remove("acme", "knowledge/ke1.md");
    const got = await service.get("acme", "ke1", "user-a"); // lazy re-projection
    expect(got.body).toBe("b");
    expect(text(fs.files.get("acme knowledge/ke1.md")?.data)).toBe("b");
    await service.remove("acme", "ke1", ACTOR);
    expect(fs.files.has("acme knowledge/ke1.md")).toBe(false);
  });
});

describe("projection helpers", () => {
  it("writeSkillContent → readSkillContent round-trips nested supporting files sorted by path", async () => {
    const fs = new FakeFs();
    await writeSkillContent(fs, "acme", "s", {
      instructions: "body",
      files: [
        { path: "z.md", content: "Z" },
        { path: "nested/a.md", content: "A" },
      ],
    });
    const content = await readSkillContent(fs, "acme", "s");
    expect(content).toEqual({
      instructions: "body",
      files: [
        { path: "nested/a.md", content: "A" },
        { path: "z.md", content: "Z" },
      ],
    });
    expect(await readSkillContent(fs, "acme", "missing")).toBeUndefined();
  });

  it("a missing skill is still the service's 404 — the projection never masks visibility", async () => {
    const service = new SkillService({ store: new FakeSkillStore(), fs: new FakeFs() });
    await expect(service.get("acme", "nope", "user-a")).rejects.toBeInstanceOf(NotFoundError);
  });
});
