import {
  BadRequestError,
  type CapabilityRecord,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type SkillRecord,
  type SkillVersionRecord,
} from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SkillStore } from "../ports/skill-store.js";
import type { SkillVersionStore } from "../ports/skill-version-store.js";
import { SkillService, type StoreCapabilityReader } from "./skill-service.js";

// Minimal in-memory store for the service tests (mirrors @everdict/db InMemorySkillStore: list = workspace skills +
// the caller's own private ones).
function fakeStore(): SkillStore {
  const byId = new Map<string, SkillRecord>();
  return {
    async create(r) {
      byId.set(r.id, r);
    },
    async get(tenant, id) {
      const r = byId.get(id);
      return r && r.tenant === tenant ? r : undefined;
    },
    async list(tenant, subject) {
      return [...byId.values()].filter(
        (r) => r.tenant === tenant && (r.visibility === "workspace" || r.createdBy === subject),
      );
    },
    async update(tenant, id, patch) {
      const r = byId.get(id);
      if (!r || r.tenant !== tenant) return undefined;
      const next = { ...r, ...patch, id: r.id, tenant: r.tenant };
      byId.set(id, next);
      return next;
    },
    async remove(tenant, id) {
      const r = byId.get(id);
      if (r && r.tenant === tenant) byId.delete(id);
    },
  };
}

// The version line, in memory — immutability is the one rule worth faking faithfully (a re-stamp throws).
function fakeVersions(): SkillVersionStore {
  const rows: SkillVersionRecord[] = [];
  return {
    async stamp(record) {
      if (rows.some((r) => r.skillId === record.skillId && r.version === record.version))
        throw new ConflictError("CONFLICT", { version: record.version }, "already stamped");
      rows.push(record);
    },
    async list(tenant, skillId) {
      return rows.filter((r) => r.tenant === tenant && r.skillId === skillId).reverse();
    },
    async get(tenant, skillId, version) {
      return rows.find((r) => r.tenant === tenant && r.skillId === skillId && r.version === version);
    },
    async remove(tenant, skillId) {
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        if (row && row.tenant === tenant && row.skillId === skillId) rows.splice(i, 1);
      }
    },
  };
}

// A store that holds one publication — enough to import from. `get` mirrors the real reader: invisible/missing is 404.
function fakeCapabilities(records: CapabilityRecord[]): StoreCapabilityReader {
  return {
    async get(_viewerTenant, id, _subject, ref, source) {
      const want = ref ?? "latest";
      const found = records.find(
        (r) =>
          r.id === id && (source === undefined || r.tenant === source) && (want === "latest" || r.version === want),
      );
      if (!found) throw new NotFoundError("NOT_FOUND", { id }, `capability '${id}' not found.`);
      return found;
    },
  };
}

const example: CapabilityRecord = {
  id: "trace-analysis",
  tenant: "_everdict",
  version: "1.2.0",
  name: "analyze_trace",
  description: "analyze one trace",
  spec: { type: "skill", instructions: "1. pull the trace", files: [{ path: "references/report.md", content: "#" }] },
  visibility: "public",
  sharedWith: [],
  tags: [],
  createdBy: "everdict",
  createdAt: "2026-07-01T00:00:00.000Z",
};

let n = 0;
function service(opts: { capabilities?: CapabilityRecord[] } = {}) {
  return new SkillService({
    store: fakeStore(),
    versions: fakeVersions(),
    capabilities: fakeCapabilities(opts.capabilities ?? [example]),
    newId: () => `sk-${n++}`,
    now: () => "2026-07-23T00:00:00.000Z",
  });
}

const base = { tenant: "acme", name: "triage", description: "d", instructions: "1. …" };

describe("SkillService", () => {
  it("creates a personal (private) draft by default", async () => {
    const svc = service();
    const rec = await svc.create({ ...base, createdBy: "alice" });
    expect(rec.visibility).toBe("private");
    expect(rec.createdBy).toBe("alice");
  });

  it("hides a private skill from other members but shows workspace skills to everyone", async () => {
    const svc = service();
    const priv = await svc.create({ ...base, createdBy: "alice", visibility: "private" });
    const shared = await svc.create({ ...base, name: "shared", createdBy: "alice", visibility: "workspace" });

    const aliceList = await svc.list("acme", "alice");
    expect(aliceList.map((s) => s.id).sort()).toEqual([priv.id, shared.id].sort());

    const bobList = await svc.list("acme", "bob");
    expect(bobList.map((s) => s.id)).toEqual([shared.id]); // bob sees only the workspace skill

    // A foreign private skill is 404 (no existence leak), a workspace one is readable by any member.
    await expect(svc.get("acme", priv.id, "bob")).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc.get("acme", shared.id, "bob")).resolves.toMatchObject({ id: shared.id });
  });

  it("shares a private draft to the workspace via a visibility update (creator)", async () => {
    const svc = service();
    const priv = await svc.create({ ...base, createdBy: "alice", visibility: "private" });
    const shared = await svc.update("acme", priv.id, { visibility: "workspace" }, { subject: "alice", isAdmin: false });
    expect(shared.visibility).toBe("workspace");
    await expect(svc.get("acme", priv.id, "bob")).resolves.toMatchObject({ id: priv.id }); // now visible to bob
  });

  it("gates management: workspace skill = creator-or-admin, private skill = creator only", async () => {
    const svc = service();
    const shared = await svc.create({ ...base, createdBy: "alice", visibility: "workspace" });
    const priv = await svc.create({ ...base, createdBy: "alice", visibility: "private" });

    // A non-creator, non-admin cannot manage a shared skill (403 — it's visible, so not a 404).
    await expect(
      svc.update("acme", shared.id, { name: "x" }, { subject: "bob", isAdmin: false }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // A workspace admin can.
    await expect(
      svc.update("acme", shared.id, { name: "x" }, { subject: "bob", isAdmin: true }),
    ).resolves.toMatchObject({ name: "x" });
    // A private skill is invisible to others → managing it is 404 even for an admin (no admin override on personal drafts).
    await expect(svc.remove("acme", priv.id, { subject: "bob", isAdmin: true })).rejects.toBeInstanceOf(NotFoundError);
    // The creator can delete their own private draft.
    await expect(svc.remove("acme", priv.id, { subject: "alice", isAdmin: false })).resolves.toBeUndefined();
  });
});

describe("SkillService — taking a store example into the workspace", () => {
  it("copies the publication into an ORDINARY workspace skill the members can then edit", async () => {
    const svc = service();
    const copy = await svc.importFromStore({ tenant: "acme", subject: "alice", source: "_everdict", id: example.id });

    expect(copy.tenant).toBe("acme"); // it lives here now
    expect(copy.visibility).toBe("workspace"); // taken FOR the team
    expect(copy.createdBy).toBe("alice");
    expect(copy.instructions).toBe("1. pull the trace");
    expect(copy.files).toEqual([{ path: "references/report.md", content: "#" }]);
    expect(copy.version).toBe("1.2.0"); // the line continues from the version taken
    expect(copy.origin).toEqual({ source: "_everdict", id: "trace-analysis", version: "1.2.0", name: "analyze_trace" });

    // The proof it is editable like anything the workspace wrote: a plain update goes through.
    await expect(
      svc.update("acme", copy.id, { instructions: "our own steps" }, { subject: "alice", isAdmin: false }),
    ).resolves.toMatchObject({ instructions: "our own steps" });
  });

  it("refuses a second copy of the same publication, naming the one already here", async () => {
    const svc = service();
    await svc.importFromStore({ tenant: "acme", subject: "alice", source: "_everdict", id: example.id });
    await expect(
      svc.importFromStore({ tenant: "acme", subject: "bob", source: "_everdict", id: example.id }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a publication that is not a skill — a tool does not belong in the skill library", async () => {
    const tool: CapabilityRecord = {
      ...example,
      id: "web-search",
      spec: {
        type: "code",
        language: "node",
        code: "…",
        parametersSchema: {},
        examples: [],
        isReadOnly: true,
        requiredSecrets: [],
      },
    };
    const svc = service({ capabilities: [tool] });
    await expect(
      svc.importFromStore({ tenant: "acme", subject: "alice", source: "_everdict", id: "web-search" }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe("SkillService — stamping versions", () => {
  it("opens every skill's line at its own version, so the current version always names real content", async () => {
    const svc = service();
    const skill = await svc.create({ ...base, createdBy: "alice" });
    const line = await svc.listVersions("acme", skill.id, "alice");
    expect(line.map((v) => v.version)).toEqual(["1.0.0"]);
    expect(line[0]?.instructions).toBe("1. …");
  });

  it("freezes the CURRENT content at the bumped version and leaves the working copy untouched", async () => {
    const svc = service();
    const skill = await svc.create({ ...base, createdBy: "alice", visibility: "workspace" });
    await svc.update("acme", skill.id, { instructions: "2. revised" }, { subject: "alice", isAdmin: false });

    const { skill: after, stamped } = await svc.stampVersion(
      "acme",
      skill.id,
      { bump: "minor", note: "revised in conversation" },
      { subject: "alice", isAdmin: false },
    );
    expect(after.version).toBe("1.1.0");
    expect(stamped.instructions).toBe("2. revised"); // the edit is what got named
    expect(stamped.note).toBe("revised in conversation");
    // The older point still says what it said — that is what makes it citable.
    expect((await svc.getVersion("acme", skill.id, "1.0.0", "alice")).instructions).toBe("1. …");
    expect((await svc.listVersions("acme", skill.id, "alice")).map((v) => v.version)).toEqual(["1.1.0", "1.0.0"]);
  });

  it("refuses a version that does not come after the current one — a line only moves forward", async () => {
    const svc = service();
    const skill = await svc.create({ ...base, createdBy: "alice" });
    await expect(
      svc.stampVersion("acme", skill.id, { version: "0.9.0" }, { subject: "alice", isAdmin: false }),
    ).rejects.toBeInstanceOf(BadRequestError);
    await expect(
      svc.stampVersion("acme", skill.id, { version: "1.0.0" }, { subject: "alice", isAdmin: false }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("gates stamping like any other management op, and reading the line like any other read", async () => {
    const svc = service();
    const shared = await svc.create({ ...base, createdBy: "alice", visibility: "workspace" });
    await expect(
      svc.stampVersion("acme", shared.id, { bump: "patch" }, { subject: "bob", isAdmin: false }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(svc.listVersions("acme", shared.id, "bob")).resolves.toHaveLength(1); // reading is fine

    const priv = await svc.create({ ...base, createdBy: "alice", visibility: "private" });
    await expect(svc.listVersions("acme", priv.id, "bob")).rejects.toBeInstanceOf(NotFoundError);
  });
});
