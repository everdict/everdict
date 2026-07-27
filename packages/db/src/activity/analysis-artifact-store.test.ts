import type { AnalysisArtifactRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryAnalysisArtifactStore } from "./analysis-artifact-store.js";

const rec = (id: string, tenant: string, sessionId: string, createdAt: string): AnalysisArtifactRecord => ({
  id,
  tenant,
  kind: "chart",
  title: id,
  sessionId,
  pinned: false,
  spec: { type: "line", x: ["a"], series: [{ label: "s", points: [1] }] },
  createdBy: "alice",
  createdAt,
});

describe("InMemoryAnalysisArtifactStore", () => {
  it("lists a session's artifacts oldest-first and scopes by workspace", async () => {
    const store = new InMemoryAnalysisArtifactStore();
    await store.create(rec("b", "acme", "s1", "2026-07-02T00:00:00.000Z"));
    await store.create(rec("a", "acme", "s1", "2026-07-01T00:00:00.000Z"));
    await store.create(rec("other-session", "acme", "s2", "2026-07-01T00:00:00.000Z"));
    await store.create(rec("other-ws", "beta", "s1", "2026-07-01T00:00:00.000Z"));
    expect((await store.listBySession("acme", "s1")).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("get can't read another workspace's artifact (no existence leak)", async () => {
    const store = new InMemoryAnalysisArtifactStore();
    await store.create(rec("a", "acme", "s1", "2026-07-01T00:00:00.000Z"));
    expect(await store.get("beta", "a")).toBeUndefined();
    expect((await store.get("acme", "a"))?.title).toBe("a");
  });

  it("attachToView pins the artifact onto the view; listByView returns the view's artifacts newest-first", async () => {
    const store = new InMemoryAnalysisArtifactStore();
    await store.create(rec("old", "acme", "s1", "2026-07-01T00:00:00.000Z"));
    await store.create(rec("new", "acme", "s2", "2026-07-02T00:00:00.000Z"));
    await store.create(rec("unrelated", "acme", "s3", "2026-07-03T00:00:00.000Z"));
    await store.attachToView("acme", "old", "v-1");
    await store.attachToView("acme", "new", "v-1");
    await store.attachToView("beta", "unrelated", "v-1"); // wrong workspace — no-op
    expect((await store.listByView("acme", "v-1")).map((r) => [r.id, r.pinned])).toEqual([
      ["new", true],
      ["old", true],
    ]);
    expect((await store.get("acme", "unrelated"))?.viewId).toBeUndefined();
  });

  it("detachFromView unpins; summarizeByView rolls up per-view counts + the newest report time", async () => {
    const store = new InMemoryAnalysisArtifactStore();
    await store.create(rec("chart1", "acme", "s1", "2026-07-01T00:00:00.000Z"));
    await store.create({ ...rec("rep1", "acme", "s1", "2026-07-02T00:00:00.000Z"), kind: "report" });
    await store.create({ ...rec("rep2", "acme", "s2", "2026-07-03T00:00:00.000Z"), kind: "report" });
    await store.attachToView("acme", "chart1", "v-1");
    await store.attachToView("acme", "rep1", "v-1");
    await store.attachToView("acme", "rep2", "v-2");

    expect(await store.summarizeByView("acme")).toEqual({
      "v-1": { count: 2, lastReportAt: "2026-07-02T00:00:00.000Z" },
      "v-2": { count: 1, lastReportAt: "2026-07-03T00:00:00.000Z" },
    });

    await store.detachFromView("acme", "rep1");
    expect((await store.get("acme", "rep1"))?.pinned).toBe(false);
    expect((await store.summarizeByView("acme"))["v-1"]).toEqual({ count: 1 }); // chart only — no report time
  });
});
