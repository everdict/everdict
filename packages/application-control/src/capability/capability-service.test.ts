import { type CapabilityRecord, ForbiddenError, NotFoundError } from "@everdict/contracts";
import { compareVersions } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { CapabilityStore } from "../ports/capability-store.js";
import { CapabilityService } from "./capability-service.js";

// Minimal in-memory store for the service tests (mirrors @everdict/db InMemoryCapabilityStore — application-control
// can't import db). Only the behaviour the service exercises; conflict immutability is covered in the db store test.
function fakeStore(): CapabilityStore {
  const rows: { record: CapabilityRecord; deleted: boolean }[] = [];
  const find = (t: string, id: string, v: string) =>
    rows.find((r) => r.record.tenant === t && r.record.id === id && r.record.version === v && !r.deleted);
  const live = () => rows.filter((r) => !r.deleted).map((r) => r.record);
  const latestPer = (recs: CapabilityRecord[]) => {
    const m = new Map<string, CapabilityRecord>();
    for (const r of recs) {
      const k = `${r.tenant} ${r.id}`;
      const cur = m.get(k);
      if (!cur || compareVersions(r.version, cur.version) > 0) m.set(k, r);
    }
    return [...m.values()];
  };
  return {
    async register(record) {
      const existing = rows.find(
        (r) => r.record.tenant === record.tenant && r.record.id === record.id && r.record.version === record.version,
      );
      if (existing) {
        existing.deleted = false;
        existing.record = record;
        return;
      }
      rows.push({ record, deleted: false });
    },
    async get(tenant, id, ref = "latest") {
      const vs = live()
        .filter((r) => r.tenant === tenant && r.id === id)
        .sort((a, b) => compareVersions(a.version, b.version));
      if (vs.length === 0) return undefined;
      return ref === "latest" ? vs[vs.length - 1] : vs.find((r) => r.version === ref);
    },
    async getVersion(owner, id, version) {
      return find(owner, id, version)?.record;
    },
    async versions(tenant, id) {
      return live()
        .filter((r) => r.tenant === tenant && r.id === id)
        .map((r) => r.version)
        .sort((a, b) => compareVersions(a, b));
    },
    async listVisible(tenant, subject) {
      return latestPer(live()).filter(
        (r) =>
          (r.tenant === tenant && (r.visibility !== "private" || r.createdBy === subject)) ||
          (r.visibility === "subset" && r.sharedWith.includes(tenant)),
      );
    },
    async listPublic() {
      return latestPer(live()).filter((r) => r.visibility === "public");
    },
    async setVisibility(tenant, id, next) {
      for (const r of rows)
        if (!r.deleted && r.record.tenant === tenant && r.record.id === id) r.record = { ...r.record, ...next };
    },
    async softDelete(tenant, id, version) {
      const e = find(tenant, id, version);
      if (e) e.deleted = true;
    },
    async creatorOfVersion(tenant, id, version) {
      return find(tenant, id, version)?.record.createdBy;
    },
  };
}

const svc = () => new CapabilityService({ store: fakeStore(), now: () => "2026-07-24T00:00:00.000Z" });
const skill = (over: { name?: string; description?: string } = {}) => ({
  name: over.name ?? "triage",
  description: over.description ?? "d",
  spec: { type: "skill" as const, instructions: "1. …" },
});
const admin = (subject: string) => ({ subject, isAdmin: true });
const member = (subject: string) => ({ subject, isAdmin: false });

describe("CapabilityService", () => {
  it("creates a private capability at 1.0.0 and patch-bumps on an owner's content edit (idempotent when unchanged)", async () => {
    const s = svc();
    expect(await s.save("acme", member("alice"), "triage", skill())).toMatchObject({ version: "1.0.0", created: true });
    expect(await s.save("acme", member("alice"), "triage", skill())).toMatchObject({
      version: "1.0.0",
      created: false,
    });
    expect(await s.save("acme", member("alice"), "triage", skill({ description: "d2" }))).toMatchObject({
      version: "1.0.1",
      created: true,
    });
  });

  it("lets only the owner or an admin publish a new version", async () => {
    const s = svc();
    await s.save("acme", member("alice"), "t", skill());
    await expect(s.save("acme", member("bob"), "t", skill({ description: "x" }))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(s.save("acme", admin("bob"), "t", skill({ description: "x" }))).resolves.toMatchObject({
      created: true,
    });
  });

  it("requires an admin to publish a brand-new capability as public", async () => {
    const s = svc();
    await expect(s.save("acme", member("alice"), "pub", { ...skill(), visibility: "public" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(s.save("acme", admin("alice"), "pub", { ...skill(), visibility: "public" })).resolves.toMatchObject({
      created: true,
    });
  });

  it("inherits the current reach across a content edit — an edit never silently re-shares", async () => {
    const s = svc();
    await s.save("acme", admin("alice"), "t", { ...skill(), visibility: "workspace" });
    await s.save("acme", member("alice"), "t", skill({ description: "v2" }));
    const rec = await s.get("acme", "t", "alice");
    expect(rec.visibility).toBe("workspace");
    expect(rec.version).toBe("1.0.1");
  });

  it("404s a capability the caller cannot see (another member's private draft)", async () => {
    const s = svc();
    await s.save("acme", member("alice"), "secret", skill());
    await expect(s.get("acme", "secret", "bob")).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.get("acme", "secret", "alice")).resolves.toMatchObject({ id: "secret" });
  });

  it("gates setVisibility to owner-or-admin and requires an admin to reach public", async () => {
    const s = svc();
    await s.save("acme", member("alice"), "t", { ...skill(), visibility: "private" });
    await expect(
      s.setVisibility("acme", "t", { visibility: "workspace", sharedWith: [] }, member("bob")),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      s.setVisibility("acme", "t", { visibility: "workspace", sharedWith: [] }, member("alice")),
    ).resolves.toMatchObject({ visibility: "workspace" });
    await expect(
      s.setVisibility("acme", "t", { visibility: "public", sharedWith: [] }, member("alice")),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      s.setVisibility("acme", "t", { visibility: "public", sharedWith: [] }, admin("alice")),
    ).resolves.toMatchObject({ visibility: "public" });
  });

  it("shares to a subset of workspaces, making it visible there but nowhere else", async () => {
    const s = svc();
    await s.save("acme", member("alice"), "t", { ...skill(), visibility: "private" });
    await s.setVisibility("acme", "t", { visibility: "subset", sharedWith: ["beta"] }, member("alice"));
    expect((await s.list("beta", "carol")).map((r) => r.id)).toEqual(["t"]);
    expect((await s.list("delta", "carol")).map((r) => r.id)).toEqual([]);
  });

  it("deletes a version only for its creator or an admin, 404 for a missing version", async () => {
    const s = svc();
    await s.save("acme", member("alice"), "t", { ...skill(), visibility: "workspace" });
    await expect(s.deleteVersion("acme", "t", "1.0.0", member("bob"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.deleteVersion("acme", "t", "9.9.9", member("alice"))).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.deleteVersion("acme", "t", "1.0.0", member("alice"))).resolves.toBeUndefined();
  });
});
