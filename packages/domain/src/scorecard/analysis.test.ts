import { describe, expect, it } from "vitest";
import {
  type AnalysisCard,
  type AnalysisConfig,
  analysisDimensionValue,
  analysisMetricNames,
  computeAnalysis,
} from "./analysis.js";

// Fixtures mirror the web engine's semantics (apps/web/.../analyze-scorecards/model/analysis.ts) — these tests
// are the lockstep guard for the server-side twin.

const card = (id: string, extra: Partial<AnalysisCard> = {}): AnalysisCard => ({
  id,
  dataset: { id: "pinch-core", version: "1.0.0" },
  harness: { id: "hermes-desktop", version: "1.0.0" },
  status: "succeeded",
  createdAt: "2026-06-01T00:00:00Z",
  summary: [{ metric: "judge", count: 10, mean: 0.8, passRate: 0.8 }],
  ...extra,
});

const config = (extra: Partial<AnalysisConfig> = {}): AnalysisConfig => ({
  filters: {},
  groupBy: ["harness"],
  measure: "passRate",
  sort: { by: "measure", dir: "desc" },
  viz: "table",
  ...extra,
});

describe("analysisDimensionValue", () => {
  it("resolves version, model (primary → observed → unknown), origin and time dimensions", () => {
    const c = card("a", {
      createdAt: "2026-06-15T10:00:00Z",
      models: { observed: ["gpt-x"], primary: "claude-y" },
      judgeModels: ["judge-z"],
      origin: { source: "schedule", repo: "acme/app" },
      createdBy: "user-1",
    });
    expect(analysisDimensionValue(c, "datasetVersion")).toBe("pinch-core@1.0.0");
    expect(analysisDimensionValue(c, "harnessVersion")).toBe("hermes-desktop@1.0.0");
    expect(analysisDimensionValue(c, "model")).toBe("claude-y");
    expect(analysisDimensionValue(card("b", { models: { observed: ["gpt-x"] } }), "model")).toBe("gpt-x");
    expect(analysisDimensionValue(card("c"), "model")).toBe("—");
    expect(analysisDimensionValue(c, "judgeModel")).toBe("judge-z");
    expect(analysisDimensionValue(c, "originSource")).toBe("schedule");
    expect(analysisDimensionValue(c, "repo")).toBe("acme/app");
    expect(analysisDimensionValue(c, "owner")).toBe("user-1");
    expect(analysisDimensionValue(c, "day")).toBe("2026-06-15");
    expect(analysisDimensionValue(c, "month")).toBe("2026-06");
    expect(analysisDimensionValue(c, "week")).toBe("2026-W25");
  });
});

describe("analysisMetricNames", () => {
  it("orders metric names by frequency", () => {
    const names = analysisMetricNames([
      card("a", { summary: [{ metric: "judge", count: 1, mean: 1 }] }),
      card("b", { summary: [{ metric: "cost", count: 1, mean: 1 }] }),
      card("c", { summary: [{ metric: "cost", count: 1, mean: 1 }] }),
    ]);
    expect(names).toEqual(["cost", "judge"]);
  });
});

describe("computeAnalysis — filters", () => {
  it("excludes incomplete statuses by default, includes them with includeIncomplete", () => {
    const cards = [
      card("a"),
      card("b", { status: "running" }),
      card("c", { status: "superseded" }),
      card("d", { status: "cancelled" }),
      card("e", { status: "queued" }),
      card("f", { status: "failed" }),
    ];
    expect(computeAnalysis(cards, config()).total).toBe(2); // succeeded + failed
    expect(computeAnalysis(cards, config({ includeIncomplete: true })).total).toBe(6);
  });

  it("applies list filters, date range, and search over the haystack", () => {
    const cards = [
      card("a", { dataset: { id: "d1", version: "1" }, createdAt: "2026-06-01T00:00:00Z" }),
      card("b", { dataset: { id: "d2", version: "1" }, createdAt: "2026-06-10T00:00:00Z", createdBy: "user-1" }),
    ];
    expect(computeAnalysis(cards, config({ filters: { dataset: ["d1"] } })).total).toBe(1);
    expect(computeAnalysis(cards, config({ filters: { from: "2026-06-05" } })).total).toBe(1);
    expect(computeAnalysis(cards, config({ filters: { to: "2026-06-05" } })).total).toBe(1);
    expect(computeAnalysis(cards, config({ search: "d2" })).total).toBe(1);
    // The search haystack includes the RESOLVED owner name.
    const byOwner = computeAnalysis(cards, config({ search: "alice" }), {
      resolveOwner: (s) => (s === "user-1" ? "Alice" : s),
    });
    expect(byOwner.total).toBe(1);
  });
});

describe("computeAnalysis — grid", () => {
  it("groups by dimensions, aggregates the measure, and sorts by measure desc", () => {
    const cards = [
      card("a", {
        harness: { id: "h1", version: "1" },
        summary: [{ metric: "judge", count: 1, mean: 0.2, passRate: 0.2 }],
      }),
      card("b", {
        harness: { id: "h1", version: "1" },
        summary: [{ metric: "judge", count: 1, mean: 0.4, passRate: 0.4 }],
      }),
      card("c", {
        harness: { id: "h2", version: "1" },
        summary: [{ metric: "judge", count: 1, mean: 0.9, passRate: 0.9 }],
      }),
    ];
    const r = computeAnalysis(cards, config());
    if (r.kind !== "grid") throw new Error("expected grid");
    expect(r.rows.map((row) => row.labels[0])).toEqual(["h2", "h1"]);
    expect(r.rows.map((row) => row.value)).toEqual([0.9, expect.closeTo(0.3, 5)]);
    expect(r.rows.map((row) => row.count)).toEqual([1, 2]);
  });

  it("count and latest measures", () => {
    const cards = [
      card("a", {
        createdAt: "2026-06-01T00:00:00Z",
        summary: [{ metric: "judge", count: 1, mean: 0.1, passRate: 0.1 }],
      }),
      card("b", {
        createdAt: "2026-06-02T00:00:00Z",
        summary: [{ metric: "judge", count: 1, mean: 0.9, passRate: 0.9 }],
      }),
    ];
    const count = computeAnalysis(cards, config({ measure: "count" }));
    if (count.kind !== "grid") throw new Error("expected grid");
    expect(count.rows[0]?.value).toBe(2);
    const latest = computeAnalysis(cards, config({ measure: "latest" }));
    if (latest.kind !== "grid") throw new Error("expected grid");
    expect(latest.rows[0]?.value).toBe(0.9);
  });

  it("pivots into sorted columns with per-cell aggregates", () => {
    const cards = [
      card("a", { harness: { id: "h1", version: "1" }, dataset: { id: "d2", version: "1" } }),
      card("b", {
        harness: { id: "h1", version: "1" },
        dataset: { id: "d1", version: "1" },
        summary: [{ metric: "judge", count: 1, mean: 0.5, passRate: 0.5 }],
      }),
    ];
    const r = computeAnalysis(cards, config({ pivotBy: "dataset" }));
    if (r.kind !== "grid") throw new Error("expected grid");
    expect(r.pivotKeys).toEqual(["d1", "d2"]);
    expect(r.rows[0]?.cells.map((cell) => cell.value)).toEqual([0.5, 0.8]);
  });

  it("selected-but-absent metric falls back to the card's first summary row", () => {
    const cards = [card("a", { summary: [{ metric: "cost", count: 1, mean: 0.42 }] })];
    const r = computeAnalysis(cards, config({ metric: "judge" }));
    if (r.kind !== "grid") throw new Error("expected grid");
    expect(r.rows[0]?.value).toBe(0.42); // cost has no passRate → mean
  });

  it("two-dimension group keys cannot collide across the dimension boundary", () => {
    const cards = [
      card("a", { harness: { id: "ab", version: "1" }, dataset: { id: "c", version: "1" } }),
      card("b", { harness: { id: "a", version: "1" }, dataset: { id: "bc", version: "1" } }),
    ];
    const r = computeAnalysis(cards, config({ groupBy: ["harness", "dataset"] }));
    if (r.kind !== "grid") throw new Error("expected grid");
    expect(r.rows).toHaveLength(2); // "ab"+"c" and "a"+"bc" stay distinct groups
  });

  it("sorts by label ascending when requested", () => {
    const cards = [
      card("a", { harness: { id: "zeta", version: "1" } }),
      card("b", { harness: { id: "alpha", version: "1" } }),
    ];
    const r = computeAnalysis(cards, config({ sort: { by: "label", dir: "asc" } }));
    if (r.kind !== "grid") throw new Error("expected grid");
    expect(r.rows.map((row) => row.labels[0])).toEqual(["alpha", "zeta"]);
  });
});

describe("computeAnalysis — line", () => {
  it("buckets by the time dimension with one series per non-time dimension value", () => {
    const cards = [
      card("a", { createdAt: "2026-06-01T00:00:00Z", harness: { id: "h1", version: "1" } }),
      card("b", {
        createdAt: "2026-06-02T00:00:00Z",
        harness: { id: "h2", version: "1" },
        summary: [{ metric: "judge", count: 1, mean: 0.5, passRate: 0.5 }],
      }),
    ];
    const r = computeAnalysis(cards, config({ viz: "line", groupBy: ["day", "harness"] }));
    if (r.kind !== "line") throw new Error("expected line");
    expect(r.buckets).toEqual(["2026-06-01", "2026-06-02"]);
    expect(r.series.map((s) => s.label)).toEqual(["h1", "h2"]);
    expect(r.series[0]?.points).toEqual([0.8, undefined]); // h1 has no card in the second bucket
    expect(r.series[1]?.points).toEqual([undefined, 0.5]);
  });

  it("uses the injected allLabel for the single series when groupBy has no non-time dimension", () => {
    const r = computeAnalysis([card("a")], config({ viz: "line", groupBy: ["day"] }), { allLabel: "everything" });
    if (r.kind !== "line") throw new Error("expected line");
    expect(r.series).toHaveLength(1);
    expect(r.series[0]?.label).toBe("everything");
  });

  it("defaults the time dimension to day when groupBy has none", () => {
    const r = computeAnalysis([card("a")], config({ viz: "line", groupBy: ["harness"] }));
    if (r.kind !== "line") throw new Error("expected line");
    expect(r.buckets).toEqual(["2026-06-01"]);
    expect(r.series[0]?.label).toBe("hermes-desktop");
  });
});
