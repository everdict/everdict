import {
  type CapabilityRecord,
  ForbiddenError,
  type ImageRegistryCoordinates,
  NotFoundError,
} from "@everdict/contracts";
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
  spec: { type: "skill" as const, instructions: "1. …", files: [] },
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

  it("validate() predicts the version a save would assign without writing", async () => {
    const s = svc();
    // brand-new id → 1.0.0, no existing versions, nothing written
    expect(await s.validate("acme", "triage", skill())).toMatchObject({
      type: "skill",
      willCreate: true,
      version: "1.0.0",
      existingVersions: [],
    });
    expect(await s.list("acme", "alice")).toEqual([]); // validate never registers

    await s.save("acme", member("alice"), "triage", skill());
    // unchanged content → no-op (willCreate false, current version)
    expect(await s.validate("acme", "triage", skill())).toMatchObject({
      willCreate: false,
      version: "1.0.0",
      existingVersions: ["1.0.0"],
    });
    // changed content → next patch
    expect(await s.validate("acme", "triage", skill({ description: "d2" }))).toMatchObject({
      willCreate: true,
      version: "1.0.1",
      existingVersions: ["1.0.0"],
    });
  });
});

// Instance policy (operator EVERDICT_ALLOW_MEMBER_PUBLIC_PUBLISH) — when opted in, a plain member may publish/promote
// to `public` (the community-instance model), otherwise public stays admin-gated.
describe("CapabilityService — member public-publish policy", () => {
  const open = () =>
    new CapabilityService({
      store: fakeStore(),
      allowMemberPublicPublish: true,
      now: () => "2026-07-27T00:00:00.000Z",
    });

  it("lets a member publish a new capability public when the instance opts in", async () => {
    const s = open();
    await expect(s.save("acme", member("alice"), "pub", { ...skill(), visibility: "public" })).resolves.toMatchObject({
      created: true,
    });
  });

  it("lets a member promote reach to public when the instance opts in", async () => {
    const s = open();
    await s.save("acme", member("alice"), "t", { ...skill(), visibility: "private" });
    await expect(
      s.setVisibility("acme", "t", { visibility: "public", sharedWith: [] }, member("alice")),
    ).resolves.toMatchObject({ visibility: "public" });
  });
});

// First-party (Everdict-authored) built-ins surfaced in the public catalog — merged in FIRST, ahead of user-published
// public capabilities, so the store shows "the same tool, two channels: default + marketplace".
describe("CapabilityService — first-party built-ins in the public catalog", () => {
  const builtIn: CapabilityRecord = {
    id: "web-search",
    tenant: "_everdict",
    version: "1.0.0",
    name: "web_search",
    description: "Search the web",
    spec: { type: "code", language: "node", code: "…", parametersSchema: {}, isReadOnly: true, requiredSecrets: [] },
    visibility: "public",
    sharedWith: [],
    tags: ["built-in"],
    createdBy: "everdict",
    createdAt: "2026-07-27T00:00:00.000Z",
  };
  const s = () =>
    new CapabilityService({
      store: fakeStore(),
      firstPartyCatalog: () => [builtIn],
      now: () => "2026-07-27T00:00:00.000Z",
    });

  it("merges the built-ins ahead of the DB public capabilities", async () => {
    const svcWith = s();
    await svcWith.save("acme", admin("alice"), "custom", { ...skill(), visibility: "public" });
    const listed = await svcWith.listPublic("beta");
    expect(listed.map((c) => c.id)).toEqual(["web-search", "custom"]);
    expect(listed[0]?.tenant).toBe("_everdict");
  });

  it("shows the built-ins even with an empty DB catalog", async () => {
    expect((await s().listPublic("beta")).map((c) => c.id)).toEqual(["web-search"]);
  });
});

// Environment kind — publish-time image classification (docs/architecture/environment-image-store.md). Warn-not-block:
// a warning never fails the save, and a coordinates failure yields no warnings.
describe("CapabilityService — environment image warnings", () => {
  const environment = (image: string) => ({
    name: "officeqa-env",
    description: "OfficeQA eval environment",
    spec: { type: "environment" as const, image, instructions: "wire it" },
  });
  const registrySvc = (coordinates: () => Promise<ImageRegistryCoordinates[]>) =>
    new CapabilityService({
      store: fakeStore(),
      registryCoordinates: coordinates,
      now: () => "2026-07-27T00:00:00.000Z",
    });
  const ghcrAcme = async (): Promise<ImageRegistryCoordinates[]> => [{ host: "ghcr.io", namespace: "acme" }];

  it("publishes a digest-pinned workspace image with no warnings", async () => {
    const s = registrySvc(ghcrAcme);
    const result = await s.save(
      "acme",
      member("alice"),
      "officeqa-env",
      environment("ghcr.io/acme/officeqa@sha256:ab12"),
    );
    expect(result).toMatchObject({ version: "1.0.0", created: true });
    expect(result.imageWarnings).toBeUndefined();
  });

  it("warns (and still saves) on an unqualified image and on a mutable tag — including the idempotent no-op path", async () => {
    const s = registrySvc(ghcrAcme);
    const unqualified = await s.save("acme", member("alice"), "e1", environment("officeqa-env:v3"));
    expect(unqualified.created).toBe(true);
    expect(unqualified.imageWarnings).toEqual([{ image: "officeqa-env:v3", class: "unqualified" }]);
    const mutable = await s.save("acme", member("alice"), "e2", environment("ghcr.io/acme/officeqa:latest"));
    expect(mutable.imageWarnings).toEqual([{ image: "ghcr.io/acme/officeqa:latest", class: "mutable-tag" }]);
    const noop = await s.save("acme", member("alice"), "e2", environment("ghcr.io/acme/officeqa:latest"));
    expect(noop.created).toBe(false);
    expect(noop.imageWarnings).toEqual([{ image: "ghcr.io/acme/officeqa:latest", class: "mutable-tag" }]);
  });

  it("never blocks a publish when the coordinates provider fails, and stays warning-free without a provider", async () => {
    const failing = registrySvc(async () => {
      throw new Error("registry lookup down");
    });
    const saved = await failing.save("acme", member("alice"), "e", environment("ghcr.io/acme/officeqa@sha256:ab"));
    expect(saved.created).toBe(true);
    expect(saved.imageWarnings).toBeUndefined();
    const bare = svc(); // no registryCoordinates dep at all
    const result = await bare.save("acme", member("alice"), "e", environment("officeqa-env:v3"));
    expect(result.imageWarnings).toBeUndefined();
  });

  it("does not classify tool kinds — a skill save carries no imageWarnings", async () => {
    const s = registrySvc(ghcrAcme);
    const result = await s.save("acme", member("alice"), "triage", skill());
    expect(result.imageWarnings).toBeUndefined();
  });

  it("annotates environment reads with the VIEWER-relative image class (publisher sees workspace, a foreign viewer external)", async () => {
    const store = fakeStore();
    const s = new CapabilityService({
      store,
      // only acme has the ghcr.io/acme registry registered — the classification is per-viewer
      registryCoordinates: async (workspace) => (workspace === "acme" ? [{ host: "ghcr.io", namespace: "acme" }] : []),
      now: () => "2026-07-27T00:00:00.000Z",
    });
    await s.save("acme", admin("alice"), "officeqa-env", {
      ...environment("ghcr.io/acme/officeqa@sha256:ab"),
      visibility: "public",
    });
    expect((await s.get("acme", "officeqa-env", "alice")).imageClass).toBe("workspace");
    const publicForBeta = await s.listPublic("beta");
    expect(publicForBeta.map((r) => [r.id, r.imageClass])).toEqual([["officeqa-env", "external"]]);
    // tool kinds are never annotated
    await s.save("acme", member("alice"), "triage", { ...skill(), visibility: "workspace" });
    const listed = await s.list("acme", "alice");
    expect(listed.find((r) => r.id === "triage")?.imageClass).toBeUndefined();
  });
});
