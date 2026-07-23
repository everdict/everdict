import { ForbiddenError, NotFoundError, type SkillRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { SkillStore } from "../ports/skill-store.js";
import { SkillService } from "./skill-service.js";

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

let n = 0;
function service() {
  return new SkillService({ store: fakeStore(), newId: () => `sk-${n++}`, now: () => "2026-07-23T00:00:00.000Z" });
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
