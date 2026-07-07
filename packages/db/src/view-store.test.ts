import { describe, expect, it } from "vitest";
import { InMemoryViewStore, type ViewRecord, type ViewVisibility } from "./view-store.js";

const rec = (
  id: string,
  tenant: string,
  createdBy: string,
  visibility: ViewVisibility,
  createdAt: string,
): ViewRecord => ({
  id,
  tenant,
  name: id,
  config: { groupBy: "harness", measure: "passRate" },
  visibility,
  createdBy,
  createdAt,
  updatedAt: createdAt,
});

describe("InMemoryViewStore", () => {
  it("listVisible returns only workspace-shared views + my private views (others' private excluded), newest first", async () => {
    const store = new InMemoryViewStore();
    await store.create(rec("mine-priv", "acme", "alice", "private", "2026-06-01T00:00:00.000Z"));
    await store.create(rec("shared", "acme", "bob", "workspace", "2026-06-02T00:00:00.000Z"));
    await store.create(rec("bob-priv", "acme", "bob", "private", "2026-06-03T00:00:00.000Z"));
    await store.create(rec("other-ws", "beta", "alice", "workspace", "2026-06-04T00:00:00.000Z"));
    // alice sees only her own private + workspace-shared. bob's private isn't visible, and other workspaces are excluded.
    expect((await store.listVisible("acme", "alice")).map((r) => r.id)).toEqual(["shared", "mine-priv"]);
  });

  it("get/update/remove can't touch another workspace (no existence leak)", async () => {
    const store = new InMemoryViewStore();
    await store.create(rec("a", "acme", "alice", "workspace", "2026-06-01T00:00:00.000Z"));
    expect(await store.get("beta", "a")).toBeUndefined();
    expect(await store.update("beta", "a", { name: "x" })).toBeUndefined();
    await store.remove("beta", "a"); // no-op
    expect(await store.get("acme", "a")).toBeDefined();
  });

  it("update merges the patch but keeps id/tenant immutable", async () => {
    const store = new InMemoryViewStore();
    await store.create(rec("a", "acme", "alice", "private", "2026-06-01T00:00:00.000Z"));
    const updated = await store.update("acme", "a", {
      name: "renamed",
      visibility: "workspace",
      tenant: "evil",
      id: "evil",
    });
    expect(updated).toMatchObject({ id: "a", tenant: "acme", name: "renamed", visibility: "workspace" });
  });
});
