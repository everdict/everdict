import { ForbiddenError, type KnowledgeEntryRecord, NotFoundError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { KnowledgeEntryStore } from "../ports/knowledge-entry-store.js";
import { KNOWLEDGE_EXTRACTION_AUTHOR, KnowledgeEntryService } from "./knowledge-entry-service.js";

// Minimal in-memory store (mirrors @everdict/db InMemoryKnowledgeEntryStore).
function fakeStore(): KnowledgeEntryStore {
  const byId = new Map<string, KnowledgeEntryRecord>();
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
function service(
  latestVersionOf?: (tenant: string, ref: { type: string; key: string }) => Promise<string | undefined>,
) {
  return new KnowledgeEntryService({
    store: fakeStore(),
    newId: () => `kn-${n++}`,
    now: () => "2026-07-28T00:00:00.000Z",
    ...(latestVersionOf !== undefined ? { latestVersionOf } : {}),
  });
}

const base = { tenant: "acme", kind: "finding" as const, title: "flaky on k8s", body: "…" };

describe("KnowledgeEntryService", () => {
  it("creates a private draft by default and records supersedes WITHOUT flipping the old entry", async () => {
    const svc = service();
    const old = await svc.create({ ...base, createdBy: "alice", visibility: "workspace" });
    const next = await svc.create({ ...base, createdBy: "bob", supersedes: old.id, visibility: "workspace" });
    expect(next.supersedes).toBe(old.id);
    // the old entry's status is an explicit, gated write — a supersede by a non-manager must not bypass the gate
    expect((await svc.get("acme", old.id, "alice")).status).toBe("active");
  });

  it("hides a private entry from other members (404, no existence leak)", async () => {
    const svc = service();
    const priv = await svc.create({ ...base, createdBy: "alice" });
    await expect(svc.get("acme", priv.id, "bob")).rejects.toBeInstanceOf(NotFoundError);
    expect((await svc.list("acme", "bob")).length).toBe(0);
  });

  it("gates managing a shared entry to creator-or-admin (403 for another member)", async () => {
    const svc = service();
    const shared = await svc.create({ ...base, createdBy: "alice", visibility: "workspace" });
    await expect(
      svc.update("acme", shared.id, { status: "deprecated" }, { subject: "bob", isAdmin: false }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const byAdmin = await svc.update("acme", shared.id, { status: "deprecated" }, { subject: "bob", isAdmin: true });
    expect(byAdmin.status).toBe("deprecated");
  });

  it("verify stamps verifiedAt without touching updatedAt (a verification is not an edit)", async () => {
    const svc = service();
    const rec = await svc.create({ ...base, createdBy: "alice", visibility: "workspace" });
    const verified = await svc.verify("acme", rec.id, { subject: "alice", isAdmin: false });
    expect(verified.verifiedAt).toBe("2026-07-28T00:00:00.000Z");
    expect(verified.updatedAt).toBe(rec.updatedAt);
  });

  it("decorates list/get with coverage when a resolver is present (interval behind the present → behind)", async () => {
    const svc = service(async (_t, ref) => (ref.key === "web-agent" ? "2.3.0" : undefined));
    const rec = await svc.create({
      ...base,
      createdBy: "alice",
      visibility: "workspace",
      refs: [{ type: "harness", key: "web-agent", version: "2.1.0" }],
    });
    const [listed] = await svc.list("acme", "alice");
    expect(listed?.coverage?.state).toBe("behind");
    expect(listed?.coverage?.gaps[0]?.latest).toBe("2.3.0");
    const got = await svc.get("acme", rec.id, "alice");
    expect(got.coverage?.state).toBe("behind");
  });

  it("verify EXTENDS each versioned pin's interval to the entity's current latest (a subject-time coordinate, not a stamp)", async () => {
    const svc = service(async (_t, ref) => (ref.key === "web-agent" ? "2.3.0" : undefined));
    const rec = await svc.create({
      ...base,
      createdBy: "alice",
      visibility: "workspace",
      refs: [
        { type: "harness", key: "web-agent", version: "2.1.0" },
        { type: "dataset", key: "unknown-family" }, // unversioned: timeless claim, untouched
      ],
    });
    const verified = await svc.verify("acme", rec.id, { subject: "alice", isAdmin: false });
    expect(verified.refs[0]?.verifiedVersion).toBe("2.3.0"); // interval is now [2.1.0, 2.3.0]
    expect(verified.refs[0]?.version).toBe("2.1.0"); // the origin pin is preserved (history, not overwritten)
    expect(verified.refs[1]?.verifiedVersion).toBeUndefined();
    expect(verified.updatedAt).toBe(rec.updatedAt); // still not an edit
    // ...and the coverage now reads current, not behind — the extension is what verify MEANS
    const got = await svc.get("acme", rec.id, "alice");
    expect(got.coverage?.state).toBe("current");
  });

  it("an edit carries verifiedVersion over for unchanged pins and resets it on a re-pin (system-owned field)", async () => {
    const svc = service(async () => "2.3.0");
    const rec = await svc.create({
      ...base,
      createdBy: "alice",
      visibility: "workspace",
      refs: [{ type: "harness", key: "web-agent", version: "2.1.0" }],
    });
    await svc.verify("acme", rec.id, { subject: "alice", isAdmin: false });
    // client PATCHes plain NodeRefs (it never sees verifiedVersion) — same pin keeps the extension
    const kept = await svc.update(
      "acme",
      rec.id,
      { refs: [{ type: "harness", key: "web-agent", version: "2.1.0" }], body: "edited" },
      { subject: "alice", isAdmin: false },
    );
    expect(kept.refs[0]?.verifiedVersion).toBe("2.3.0");
    // re-pinning to a different version starts a fresh point interval
    const repinned = await svc.update(
      "acme",
      rec.id,
      { refs: [{ type: "harness", key: "web-agent", version: "2.3.0" }] },
      { subject: "alice", isAdmin: false },
    );
    expect(repinned.refs[0]?.verifiedVersion).toBeUndefined();
  });
});

describe("extraction proposals — the HITL promotion", () => {
  const extraction = {
    sourceKind: "comment" as const,
    sourceId: "root",
    extractor: "knowledge_extractor_v1",
    confidence: 0.8,
  };

  it("propose stores a workspace-visible proposed entry authored by the extractor sentinel", async () => {
    const svc = service();
    const p = await svc.propose({ ...base, extraction });
    expect(p.status).toBe("proposed");
    expect(p.visibility).toBe("workspace");
    expect(p.createdBy).toBe(KNOWLEDGE_EXTRACTION_AUTHOR);
    expect(p.extraction).toEqual(extraction);
  });

  it("approve promotes proposed → active AND transfers authorship to the approver (extraction provenance retained)", async () => {
    const svc = service();
    const p = await svc.propose({ ...base, extraction });
    const approved = await svc.approve("acme", p.id, { subject: "alice", isAdmin: false });
    expect(approved.status).toBe("active");
    expect(approved.createdBy).toBe("alice"); // the approver now asserts and manages the claim
    expect(approved.extraction).toEqual(extraction); // the origin survives for audit
    // and the new owner passes the manage gate
    const edited = await svc.update("acme", p.id, { body: "refined" }, { subject: "alice", isAdmin: false });
    expect(edited.body).toBe("refined");
  });

  it("approve/reject 409 on a non-proposed entry; reject deletes a proposal", async () => {
    const svc = service();
    const active = await svc.create({ ...base, createdBy: "alice", visibility: "workspace" });
    await expect(svc.approve("acme", active.id, { subject: "bob", isAdmin: false })).rejects.toMatchObject({
      status: 409,
    });
    await expect(svc.reject("acme", active.id)).rejects.toMatchObject({ status: 409 });

    const p = await svc.propose({ ...base, extraction });
    await svc.reject("acme", p.id);
    await expect(svc.get("acme", p.id, "alice")).rejects.toMatchObject({ status: 404 });
  });
});
