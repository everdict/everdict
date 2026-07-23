import { ForbiddenError, NotFoundError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { BrowserProfileStore } from "../ports/browser-profile-store.js";
import { BrowserProfileService } from "./browser-profile-service.js";

// Minimal in-memory store for the service tests (mirrors @everdict/db InMemoryBrowserProfileStore semantics:
// list = workspace profiles + the caller's own private ones).
function fakeStore(): BrowserProfileStore {
  const byId = new Map<string, import("@everdict/contracts").BrowserProfileRecord>();
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
    async saveState(tenant, id, _cipher, capturedAt, cookieDomains, expiresAt) {
      const r = byId.get(id);
      if (!r || r.tenant !== tenant) return undefined;
      const next = { ...r, capturedAt, cookieDomains, expiresAt, updatedAt: capturedAt };
      byId.set(id, next);
      return next;
    },
    async loadState() {
      return undefined;
    },
  };
}

function svc(store: BrowserProfileStore) {
  let i = 0;
  return new BrowserProfileService({ store, newId: () => `bp-${i++}`, now: () => "2026-07-16T00:00:00.000Z" });
}

describe("BrowserProfileService", () => {
  it("creates a private profile by default (personal — sharing is an explicit opt-in)", async () => {
    const s = svc(fakeStore());
    const p = await s.create({ tenant: "acme", createdBy: "alice", name: "GitHub", cookieDomains: ["github.com"] });
    expect(p).toMatchObject({ id: "bp-0", name: "GitHub", visibility: "private", createdBy: "alice" });
    const shared = await s.create({ tenant: "acme", createdBy: "alice", name: "Shared", visibility: "workspace" });
    expect(shared.visibility).toBe("workspace");
  });

  it("records the geo the login session ran through (country), defaulting to null for a direct login", async () => {
    const s = svc(fakeStore());
    const geo = await s.create({ tenant: "acme", createdBy: "alice", name: "US login", country: "US" });
    expect(geo.country).toBe("US");
    const direct = await s.create({ tenant: "acme", createdBy: "alice", name: "Direct" });
    expect(direct.country).toBeNull();
  });

  it("lists workspace profiles + the caller's own private ones, hiding others' private profiles", async () => {
    const s = svc(fakeStore());
    await s.create({ tenant: "acme", createdBy: "alice", name: "MinePrivate" }); // private, alice's
    await s.create({ tenant: "acme", createdBy: "alice", name: "Shared", visibility: "workspace" }); // shared
    await s.create({ tenant: "acme", createdBy: "bob", name: "BobPrivate" }); // private, bob's — hidden from alice
    await s.create({ tenant: "acme", createdBy: "bob", name: "BobShared", visibility: "workspace" }); // shared
    const names = (await s.list("acme", "alice")).map((p) => p.name).sort();
    expect(names).toEqual(["MinePrivate", "BobShared", "Shared"].sort());
    expect(names).not.toContain("BobPrivate");
  });

  it("get resolves a workspace profile for any member, but a private one only for its creator", async () => {
    const s = svc(fakeStore());
    const priv = await s.create({ tenant: "acme", createdBy: "alice", name: "P" });
    const shared = await s.create({ tenant: "acme", createdBy: "alice", name: "S", visibility: "workspace" });
    // Any member reads a shared profile.
    expect((await s.get("acme", shared.id, "bob")).name).toBe("S");
    // A private profile is invisible to a non-creator (404 — no existence leak), visible to its creator.
    await expect(s.get("acme", priv.id, "bob")).rejects.toBeInstanceOf(NotFoundError);
    expect((await s.get("acme", priv.id, "alice")).name).toBe("P");
  });

  it("gates a private profile to its creator only — a non-creator (even an admin) gets 404, no admin override", async () => {
    const s = svc(fakeStore());
    const p = await s.create({ tenant: "acme", createdBy: "alice", name: "P" });
    // An admin cannot manage someone's private profile — it holds personal login material (404, no existence leak).
    await expect(s.update("acme", p.id, { name: "x" }, { subject: "carol", isAdmin: true })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(s.remove("acme", p.id, { subject: "bob", isAdmin: false })).rejects.toBeInstanceOf(NotFoundError);
    // The creator can.
    expect((await s.update("acme", p.id, { name: "renamed" }, { subject: "alice", isAdmin: false })).name).toBe(
      "renamed",
    );
  });

  it("gates a workspace profile creator-or-admin — a non-creator member is 403, the creator or an admin can", async () => {
    const s = svc(fakeStore());
    const p = await s.create({ tenant: "acme", createdBy: "alice", name: "S", visibility: "workspace" });
    await expect(s.update("acme", p.id, { name: "x" }, { subject: "mallory", isAdmin: false })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await s.update("acme", p.id, { name: "by-admin" }, { subject: "carol", isAdmin: true })).name).toBe(
      "by-admin",
    );
    expect((await s.update("acme", p.id, { name: "by-creator" }, { subject: "alice", isAdmin: false })).name).toBe(
      "by-creator",
    );
  });

  it("changes scope via update — the creator can share a private profile with the workspace", async () => {
    const s = svc(fakeStore());
    const p = await s.create({ tenant: "acme", createdBy: "alice", name: "P" });
    expect(p.visibility).toBe("private");
    const shared = await s.update("acme", p.id, { visibility: "workspace" }, { subject: "alice", isAdmin: false });
    expect(shared.visibility).toBe("workspace");
    // Now any member sees it.
    expect((await s.get("acme", p.id, "bob")).name).toBe("P");
  });

  it("removes a profile (creator)", async () => {
    const s = svc(fakeStore());
    const p = await s.create({ tenant: "acme", createdBy: "alice", name: "P" });
    await s.remove("acme", p.id, { subject: "alice", isAdmin: false });
    await expect(s.get("acme", p.id, "alice")).rejects.toBeInstanceOf(NotFoundError);
  });
});
