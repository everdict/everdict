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
  it("listVisible 는 워크스페이스 공유 뷰 + 내 비공개 뷰만(남의 비공개 제외), 최신순", async () => {
    const store = new InMemoryViewStore();
    await store.create(rec("mine-priv", "acme", "alice", "private", "2026-06-01T00:00:00.000Z"));
    await store.create(rec("shared", "acme", "bob", "workspace", "2026-06-02T00:00:00.000Z"));
    await store.create(rec("bob-priv", "acme", "bob", "private", "2026-06-03T00:00:00.000Z"));
    await store.create(rec("other-ws", "beta", "alice", "workspace", "2026-06-04T00:00:00.000Z"));
    // alice 는 자기 비공개 + 워크스페이스 공유만. bob 의 비공개는 안 보이고, 다른 워크스페이스도 제외.
    expect((await store.listVisible("acme", "alice")).map((r) => r.id)).toEqual(["shared", "mine-priv"]);
  });

  it("get/update/remove 는 타 워크스페이스를 건드리지 못한다(존재 누출 금지)", async () => {
    const store = new InMemoryViewStore();
    await store.create(rec("a", "acme", "alice", "workspace", "2026-06-01T00:00:00.000Z"));
    expect(await store.get("beta", "a")).toBeUndefined();
    expect(await store.update("beta", "a", { name: "x" })).toBeUndefined();
    await store.remove("beta", "a"); // no-op
    expect(await store.get("acme", "a")).toBeDefined();
  });

  it("update 는 patch 를 병합하되 id/tenant 는 불변", async () => {
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
