import type { AnalysisArtifactRecord } from "@everdict/contracts";
import { InMemoryAnalysisArtifactStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { type ArtifactToolContext, buildArtifactTools } from "./artifact-tools.js";

function makeContext(over: Partial<ArtifactToolContext> = {}): {
  ctx: ArtifactToolContext;
  store: InMemoryAnalysisArtifactStore;
  emitted: AnalysisArtifactRecord[];
} {
  let n = 0;
  const store = new InMemoryAnalysisArtifactStore();
  const emitted: AnalysisArtifactRecord[] = [];
  const ctx: ArtifactToolContext = {
    artifacts: store,
    tenant: "acme",
    sessionId: "s1",
    createdBy: "alice",
    now: () => "2026-07-27T00:00:00.000Z",
    newId: () => `art-${n++}`,
    onArtifact: (record) => emitted.push(record),
    ...over,
  };
  return { ctx, store, emitted };
}

const toolCtx = {};

describe("artifact emission tools", () => {
  it("render_chart validates the spec, persists the record on the conversation, and notifies the host", async () => {
    const { ctx, store, emitted } = makeContext();
    const chart = buildArtifactTools(ctx).find((t) => t.name === "render_chart");
    if (!chart) throw new Error("render_chart missing");
    expect(chart.isReadOnly).toBe(true); // conversation-scoped presentation output — no HITL gate (todo precedent)

    const result = await chart.call(
      {
        title: "Pass rate by harness",
        spec: {
          type: "bar",
          x: ["h1", "h2"],
          series: [{ label: "passRate", points: [0.4, 0.9] }],
          yUnit: "ratio",
        },
      },
      toolCtx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('chart "Pass rate by harness"');

    const stored = await store.listBySession("acme", "s1");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      kind: "chart",
      title: "Pass rate by harness",
      createdBy: "alice",
      pinned: false,
    });
    expect(emitted).toEqual(stored); // the SSE hook got the same record
  });

  it("render_table and write_report persist their kinds", async () => {
    const { ctx, store } = makeContext();
    const tools = buildArtifactTools(ctx);
    const table = tools.find((t) => t.name === "render_table");
    const report = tools.find((t) => t.name === "write_report");
    if (!table || !report) throw new Error("tools missing");

    await table.call({ title: "Failures", columns: ["case", "verdict"], rows: [["c1", "fail"]] }, toolCtx);
    await report.call({ title: "Weekly report", markdown: "# Findings\nAll green." }, toolCtx);

    const kinds = (await store.listBySession("acme", "s1")).map((r) => r.kind);
    expect(kinds).toEqual(["table", "report"]);
  });

  it("an invalid chart spec throws (the loop turns it into a correctable tool error) and persists nothing", async () => {
    const { ctx, store } = makeContext();
    const chart = buildArtifactTools(ctx).find((t) => t.name === "render_chart");
    if (!chart) throw new Error("render_chart missing");
    await expect(chart.call({ title: "bad", spec: { type: "pie", x: [], series: [] } }, toolCtx)).rejects.toThrow();
    expect(await store.listBySession("acme", "s1")).toEqual([]);
  });
});
