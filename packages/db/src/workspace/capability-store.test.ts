import { type CapabilityRecord, ConflictError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";

import { InMemoryCapabilityStore } from "./capability-store.js";

const cap = (over: Partial<CapabilityRecord> = {}): CapabilityRecord => ({
  id: "triage",
  tenant: "acme",
  version: "1.0.0",
  name: "triage",
  description: "when to triage",
  spec: { type: "skill", instructions: "do the thing" },
  visibility: "workspace",
  sharedWith: [],
  tags: [],
  createdBy: "alice",
  createdAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

describe("InMemoryCapabilityStore", () => {
  it("registers immutable versions and resolves latest / exact", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(cap({ version: "1.0.0" }));
    await store.register(cap({ version: "1.1.0", description: "v2" }));
    expect((await store.get("acme", "triage"))?.version).toBe("1.1.0"); // latest
    expect((await store.get("acme", "triage", "1.0.0"))?.description).toBe("when to triage");
    expect(await store.versions("acme", "triage")).toEqual(["1.0.0", "1.1.0"]);
  });

  it("rejects re-registering a version with different content but is idempotent for identical content", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(cap({ version: "1.0.0" }));
    await store.register(cap({ version: "1.0.0" })); // identical → no-op
    await expect(store.register(cap({ version: "1.0.0", description: "changed" }))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("does not treat a reach (visibility) change as a content conflict", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(cap({ version: "1.0.0", visibility: "private" }));
    // same content, different visibility metadata → idempotent, not a conflict
    await expect(store.register(cap({ version: "1.0.0", visibility: "public" }))).resolves.toBeUndefined();
  });

  it("soft-deletes a version (hidden from reads) and revives it on identical re-register", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(cap({ version: "1.0.0" }));
    await store.register(cap({ version: "1.1.0" }));
    await store.softDelete("acme", "triage", "1.1.0");
    expect((await store.get("acme", "triage"))?.version).toBe("1.0.0"); // falls back to the live version
    expect(await store.versions("acme", "triage")).toEqual(["1.0.0"]);
    await store.register(cap({ version: "1.1.0" })); // identical content revives the tombstone
    expect(await store.versions("acme", "triage")).toEqual(["1.0.0", "1.1.0"]);
  });

  it("listVisible returns own-visible + subset-shared-to-me, excludes others' workspace/private/public", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(cap({ id: "mine-priv", tenant: "acme", createdBy: "alice", visibility: "private" }));
    await store.register(cap({ id: "bob-priv", tenant: "acme", createdBy: "bob", visibility: "private" }));
    await store.register(cap({ id: "ws", tenant: "acme", visibility: "workspace" }));
    await store.register(cap({ id: "shared-in", tenant: "beta", visibility: "subset", sharedWith: ["acme"] }));
    await store.register(cap({ id: "other-ws", tenant: "beta", visibility: "workspace" }));
    await store.register(cap({ id: "other-pub", tenant: "beta", visibility: "public" })); // public from others → listPublic, not here
    const ids = (await store.listVisible("acme", "alice")).map((r) => r.id).sort();
    expect(ids).toEqual(["mine-priv", "shared-in", "ws"]);
  });

  it("listVisible resolves the latest live version per capability", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(cap({ id: "x", version: "1.0.0", visibility: "workspace" }));
    await store.register(cap({ id: "x", version: "2.0.0", visibility: "workspace", description: "newer" }));
    const rows = await store.listVisible("acme", "alice");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe("2.0.0");
  });

  it("listPublic returns only public capabilities across tenants (latest per id)", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(cap({ id: "p", tenant: "beta", visibility: "public", version: "1.0.0" }));
    await store.register(cap({ id: "p", tenant: "beta", visibility: "public", version: "1.2.0", description: "n" }));
    await store.register(cap({ id: "ws", tenant: "beta", visibility: "workspace" }));
    const pub = await store.listPublic();
    expect(pub.map((r) => `${r.tenant}/${r.id}@${r.version}`)).toEqual(["beta/p@1.2.0"]);
  });

  it("setVisibility promotes reach across every live version, making a subset visible to its targets", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(cap({ id: "s", version: "1.0.0", visibility: "private", createdBy: "alice" }));
    await store.register(cap({ id: "s", version: "1.1.0", visibility: "private", createdBy: "alice" }));
    await store.setVisibility("acme", "s", { visibility: "subset", sharedWith: ["beta"] });
    expect((await store.getVersion("acme", "s", "1.0.0"))?.visibility).toBe("subset");
    expect((await store.getVersion("acme", "s", "1.1.0"))?.sharedWith).toEqual(["beta"]);
    expect((await store.listVisible("beta", "carol")).map((r) => r.id)).toEqual(["s"]);
  });

  it("creatorOfVersion returns the registering subject for a live version, undefined once tombstoned", async () => {
    const store = new InMemoryCapabilityStore();
    await store.register(cap({ version: "1.0.0", createdBy: "alice" }));
    expect(await store.creatorOfVersion("acme", "triage", "1.0.0")).toBe("alice");
    await store.softDelete("acme", "triage", "1.0.0");
    expect(await store.creatorOfVersion("acme", "triage", "1.0.0")).toBeUndefined();
  });
});
