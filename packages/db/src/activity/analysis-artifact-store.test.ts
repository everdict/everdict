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
});
