import { AppError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { BrowserProfileStore } from "../ports/browser-profile-store.js";
import { BrowserProfileService } from "./browser-profile-service.js";

// Minimal in-memory store for the service tests (mirrors @everdict/db InMemoryBrowserProfileStore semantics).
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
    async listOwned(tenant, subject) {
      return [...byId.values()].filter((r) => r.tenant === tenant && r.createdBy === subject);
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
  it("creates a profile owned by the caller with declared cookie domains (default empty)", async () => {
    const s = svc(fakeStore());
    const p = await s.create({ tenant: "acme", createdBy: "alice", name: "GitHub", cookieDomains: ["github.com"] });
    expect(p).toMatchObject({ id: "bp-0", name: "GitHub", createdBy: "alice", cookieDomains: ["github.com"] });
    const p2 = await s.create({ tenant: "acme", createdBy: "alice", name: "Bare" });
    expect(p2.cookieDomains).toEqual([]); // default
  });

  it("records the geo the login session ran through (country), defaulting to null for a direct login", async () => {
    const s = svc(fakeStore());
    const geo = await s.create({ tenant: "acme", createdBy: "alice", name: "US login", country: "US" });
    expect(geo.country).toBe("US");
    const direct = await s.create({ tenant: "acme", createdBy: "alice", name: "Direct" });
    expect(direct.country).toBeNull();
  });

  it("lists only the caller's own profiles", async () => {
    const s = svc(fakeStore());
    await s.create({ tenant: "acme", createdBy: "alice", name: "A" });
    await s.create({ tenant: "acme", createdBy: "bob", name: "B" });
    expect((await s.list("acme", "alice")).map((p) => p.name)).toEqual(["A"]);
  });

  it("scopes get/update/remove to the owner — another subject gets 404 (no existence leak, no admin override)", async () => {
    const s = svc(fakeStore());
    const p = await s.create({ tenant: "acme", createdBy: "alice", name: "A" });
    await expect(s.get("acme", p.id, "mallory")).rejects.toBeInstanceOf(AppError);
    await expect(s.update("acme", p.id, { name: "x" }, "mallory")).rejects.toBeInstanceOf(AppError);
    await expect(s.remove("acme", p.id, "mallory")).rejects.toBeInstanceOf(AppError);
    // owner still can
    expect((await s.get("acme", p.id, "alice")).name).toBe("A");
  });

  it("updates name and cookieDomains and bumps updatedAt", async () => {
    const store = fakeStore();
    let clock = 0;
    const s = new BrowserProfileService({ store, newId: () => "bp-0", now: () => `t${clock}` });
    const p = await s.create({ tenant: "acme", createdBy: "alice", name: "A" });
    expect(p.updatedAt).toBe("t0");
    clock = 1;
    const updated = await s.update("acme", p.id, { name: "renamed", cookieDomains: ["a.com"] }, "alice");
    expect(updated).toMatchObject({ name: "renamed", cookieDomains: ["a.com"], updatedAt: "t1" });
  });

  it("removes an owned profile", async () => {
    const s = svc(fakeStore());
    const p = await s.create({ tenant: "acme", createdBy: "alice", name: "A" });
    await s.remove("acme", p.id, "alice");
    await expect(s.get("acme", p.id, "alice")).rejects.toBeInstanceOf(AppError);
  });
});
