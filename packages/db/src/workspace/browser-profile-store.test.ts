import type { BrowserProfileRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryBrowserProfileStore } from "./browser-profile-store.js";

const rec = (id: string, tenant: string, createdBy: string, createdAt: string): BrowserProfileRecord => ({
  id,
  tenant,
  name: id,
  cookieDomains: ["example.com"],
  createdBy,
  createdAt,
  updatedAt: createdAt,
});

describe("InMemoryBrowserProfileStore", () => {
  it("listOwned returns only the subject's own profiles, newest first (others excluded)", async () => {
    const store = new InMemoryBrowserProfileStore();
    await store.create(rec("a", "acme", "alice", "2026-06-01T00:00:00.000Z"));
    await store.create(rec("b", "acme", "alice", "2026-06-03T00:00:00.000Z"));
    await store.create(rec("c", "acme", "bob", "2026-06-02T00:00:00.000Z"));
    expect((await store.listOwned("acme", "alice")).map((r) => r.id)).toEqual(["b", "a"]);
    expect((await store.listOwned("acme", "bob")).map((r) => r.id)).toEqual(["c"]);
  });

  it("get/update/remove can't touch another workspace (no existence leak)", async () => {
    const store = new InMemoryBrowserProfileStore();
    await store.create(rec("a", "acme", "alice", "2026-06-01T00:00:00.000Z"));
    expect(await store.get("beta", "a")).toBeUndefined();
    expect(await store.update("beta", "a", { name: "x" })).toBeUndefined();
    await store.remove("beta", "a"); // no-op
    expect(await store.get("acme", "a")).toBeDefined();
  });

  it("update merges the patch but keeps id/tenant immutable", async () => {
    const store = new InMemoryBrowserProfileStore();
    await store.create(rec("a", "acme", "alice", "2026-06-01T00:00:00.000Z"));
    const updated = await store.update("acme", "a", {
      name: "renamed",
      cookieDomains: ["github.com"],
      tenant: "evil",
      id: "evil",
    });
    expect(updated).toMatchObject({ id: "a", tenant: "acme", name: "renamed", cookieDomains: ["github.com"] });
  });
});
