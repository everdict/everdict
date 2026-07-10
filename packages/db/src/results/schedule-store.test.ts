import type { ScheduleRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryScheduleStore } from "./schedule-store.js";

const rec = (id: string, tenant: string, createdAt: string): ScheduleRecord => ({
  id,
  tenant,
  name: id,
  cron: "0 3 * * *",
  timezone: "UTC",
  overlapPolicy: "skip",
  enabled: true,
  createdBy: "u-1",
  runTemplate: {
    dataset: { id: "d", version: "latest" },
    harness: { id: "h", version: "latest" },
    judges: [],
  },
  createdAt,
  updatedAt: createdAt,
});

describe("InMemoryScheduleStore", () => {
  it("list is workspace-scoped + newest first (createdAt DESC)", async () => {
    const store = new InMemoryScheduleStore();
    await store.create(rec("a", "acme", "2026-06-01T00:00:00.000Z"));
    await store.create(rec("b", "acme", "2026-06-02T00:00:00.000Z"));
    await store.create(rec("c", "beta", "2026-06-03T00:00:00.000Z"));
    expect((await store.list("acme")).map((r) => r.id)).toEqual(["b", "a"]); // newest first, beta excluded
    expect((await store.list("beta")).map((r) => r.id)).toEqual(["c"]);
  });

  it("get/update/remove can't touch another workspace (no existence leak)", async () => {
    const store = new InMemoryScheduleStore();
    await store.create(rec("a", "acme", "2026-06-01T00:00:00.000Z"));
    expect(await store.get("beta", "a")).toBeUndefined();
    expect(await store.update("beta", "a", { enabled: false })).toBeUndefined();
    await store.remove("beta", "a"); // no-op
    expect(await store.get("acme", "a")).toBeDefined(); // unchanged
  });

  it("update merges the patch but keeps id/tenant immutable", async () => {
    const store = new InMemoryScheduleStore();
    await store.create(rec("a", "acme", "2026-06-01T00:00:00.000Z"));
    const updated = await store.update("acme", "a", { enabled: false, cron: "0 6 * * 1", tenant: "evil", id: "evil" });
    expect(updated).toMatchObject({ id: "a", tenant: "acme", enabled: false, cron: "0 6 * * 1" });
  });
});
