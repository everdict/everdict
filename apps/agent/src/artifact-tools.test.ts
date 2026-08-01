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

  it("render_html persists a sandbox-bound html artifact (numeric dashboards)", async () => {
    const { ctx, store, emitted } = makeContext();
    const html = buildArtifactTools(ctx).find((t) => t.name === "render_html");
    if (!html) throw new Error("render_html missing");
    expect(html.isReadOnly).toBe(true); // presentation-only; execution containment is the web's sandboxed iframe

    const markup =
      '<div class="metric"><span class="metric-label">Pass rate</span>' +
      '<span class="metric-value">60%</span><span class="delta up">▲ 4.2pt</span></div>';
    const result = await html.call({ title: "Pass-rate dashboard", html: markup, height: 320 }, toolCtx);
    expect(result.isError).toBe(false);
    const stored = await store.listBySession("acme", "s1");
    expect(stored[0]).toMatchObject({ kind: "html", title: "Pass-rate dashboard" });
    expect(stored[0]?.spec).toEqual({ html: markup, height: 320 });
    expect(emitted).toHaveLength(1);
  });

  it("render_html refuses markup that paints outside the design system, and persists nothing", async () => {
    const { ctx, store } = makeContext();
    const html = buildArtifactTools(ctx).find((t) => t.name === "render_html");
    if (!html) throw new Error("render_html missing");

    // An invented palette cannot follow the member's light/dark theme — the frame publishes tokens for exactly
    // this. The throw becomes a correctable tool error, so the model re-emits with tokens.
    await expect(html.call({ title: "bad", html: '<b style="color:#22c55e">60%</b>' }, toolCtx)).rejects.toThrow(
      /var\(--chart-1\)/,
    );
    expect(await store.listBySession("acme", "s1")).toEqual([]);
  });

  it("render_html states the frame's token and class vocabulary so the model composes instead of inventing", async () => {
    const { ctx } = makeContext();
    const html = buildArtifactTools(ctx).find((t) => t.name === "render_html");
    if (!html) throw new Error("render_html missing");
    expect(html.description).toContain("--chart-1");
    expect(html.description).toContain("metric-value");
    expect(html.description).toContain("REJECTED");
  });

  it("render_dashboard persists a structured dashboard the product draws itself", async () => {
    const { ctx, store, emitted } = makeContext();
    const dashboard = buildArtifactTools(ctx).find((t) => t.name === "render_dashboard");
    if (!dashboard) throw new Error("render_dashboard missing");
    expect(dashboard.isReadOnly).toBe(true);

    const blocks = [
      {
        type: "metrics",
        metrics: [
          { label: "Pass rate", value: 0.624, unit: "ratio", baseline: 0.582 },
          { label: "Cost / case", value: 0.284, unit: "usd", baseline: 0.241, higherIsBetter: false },
        ],
      },
      { type: "note", markdown: "Cost rose with the retry change." },
    ];
    const result = await dashboard.call({ title: "Weekly eval report", blocks }, toolCtx);
    expect(result.isError).toBe(false);

    const stored = await store.listBySession("acme", "s1");
    expect(stored[0]).toMatchObject({ kind: "dashboard", title: "Weekly eval report" });
    expect(stored[0]?.spec).toEqual({ blocks });
    expect(emitted).toHaveLength(1);
  });

  it("render_dashboard refuses a block whose type and payload disagree, and persists nothing", async () => {
    const { ctx, store } = makeContext();
    const dashboard = buildArtifactTools(ctx).find((t) => t.name === "render_dashboard");
    if (!dashboard) throw new Error("render_dashboard missing");
    await expect(
      dashboard.call({ title: "bad", blocks: [{ type: "chart", markdown: "not a chart" }] }, toolCtx),
    ).rejects.toThrow();
    expect(await store.listBySession("acme", "s1")).toEqual([]);
  });

  it("steers the model to the structured kind: dashboard is preferred, html is the escape hatch", async () => {
    const { ctx } = makeContext();
    const tools = buildArtifactTools(ctx);
    // Ordering matters as much as wording — the preferred tool is the one the model reads first.
    expect(tools[0]?.name).toBe("render_dashboard");
    const dashboard = tools.find((t) => t.name === "render_dashboard");
    const html = tools.find((t) => t.name === "render_html");
    expect(dashboard?.description).toContain("PREFERRED");
    // The two instructions that carry the quality: no self-computed deltas, and polarity on cost/latency.
    expect(dashboard?.description).toContain("NEVER a delta");
    expect(dashboard?.description).toContain("higherIsBetter:false");
    expect(html?.description).toContain("ESCAPE HATCH");
    expect(html?.description).toContain("render_dashboard");
  });

  it("an invalid chart spec throws (the loop turns it into a correctable tool error) and persists nothing", async () => {
    const { ctx, store } = makeContext();
    const chart = buildArtifactTools(ctx).find((t) => t.name === "render_chart");
    if (!chart) throw new Error("render_chart missing");
    await expect(chart.call({ title: "bad", spec: { type: "pie", x: [], series: [] } }, toolCtx)).rejects.toThrow();
    expect(await store.listBySession("acme", "s1")).toEqual([]);
  });
});
