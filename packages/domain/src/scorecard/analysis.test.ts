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
    // failed is excluded too now — a batch that died mid-run must not feed its partial rate into any cell.
    expect(computeAnalysis(cards, config()).total).toBe(1); // succeeded only
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

describe("computeAnalysis — case-weighted aggregation", () => {
  // Regression: the aggregate used to be a plain mean of per-card rates, so a 5-case smoke run counted the
  // same as a 500-case suite. A rate is a ratio — a bundle's rate is Σ(rate·n)/Σn.
  it("weights passRate by each card's case count, not by the number of cards", () => {
    const cards = [
      card("suite", { summary: [{ metric: "judge", count: 500, mean: 0.8, passRate: 0.8 }] }),
      card("smoke", { summary: [{ metric: "judge", count: 5, mean: 1.0, passRate: 1.0 }] }),
    ];
    const r = computeAnalysis(cards, config());
    if (r.kind !== "grid") throw new Error("expected grid");
    // Unweighted (the old behaviour) would be (0.8 + 1.0) / 2 = 0.9 — nearly 10 points too generous.
    expect(r.rows[0]?.value).toBeCloseTo((500 * 0.8 + 5 * 1.0) / 505, 6);
    expect(r.rows[0]?.value).not.toBeCloseTo(0.9, 3);
  });

  it("weights mean the same way", () => {
    const cards = [
      card("big", { summary: [{ metric: "cost", count: 100, mean: 2 }] }),
      card("small", { summary: [{ metric: "cost", count: 1, mean: 40 }] }),
    ];
    const r = computeAnalysis(cards, config({ measure: "mean" }));
    if (r.kind !== "grid") throw new Error("expected grid");
    expect(r.rows[0]?.value).toBeCloseTo((100 * 2 + 1 * 40) / 101, 6); // not (2 + 40) / 2 = 21
  });

  it("reports the case count separately from the scorecard count", () => {
    const cards = [
      card("a", { summary: [{ metric: "judge", count: 500, mean: 0.8, passRate: 0.8 }] }),
      card("b", { summary: [{ metric: "judge", count: 5, mean: 1.0, passRate: 1.0 }] }),
    ];
    const r = computeAnalysis(cards, config());
    if (r.kind !== "grid") throw new Error("expected grid");
    expect(r.rows[0]?.count).toBe(2); // scorecards
    expect(r.rows[0]?.cases).toBe(505); // scored cases behind the value
  });

  it("still counts a card whose summary reports no usable case count, weighting it once", () => {
    const cards = [
      card("counted", { summary: [{ metric: "judge", count: 3, mean: 0, passRate: 0 }] }),
      card("legacy", { summary: [{ metric: "judge", count: 0, mean: 1, passRate: 1 }] }),
    ];
    const r = computeAnalysis(cards, config());
    if (r.kind !== "grid") throw new Error("expected grid");
    expect(r.rows[0]?.value).toBeCloseTo((3 * 0 + 1 * 1) / 4, 6); // the legacy row is not dropped
    expect(r.rows[0]?.cases).toBe(4);
  });

  it("weights the line series too, so a trend cannot be tilted by small runs", () => {
    const cards = [
      card("a", {
        createdAt: "2026-06-01T00:00:00Z",
        summary: [{ metric: "judge", count: 200, mean: 0.5, passRate: 0.5 }],
      }),
      card("b", {
        createdAt: "2026-06-01T12:00:00Z",
        summary: [{ metric: "judge", count: 2, mean: 1.0, passRate: 1.0 }],
      }),
    ];
    const r = computeAnalysis(cards, config({ groupBy: ["day"], viz: "line" }));
    if (r.kind !== "line") throw new Error("expected line");
    expect(r.series[0]?.points[0]).toBeCloseTo((200 * 0.5 + 2 * 1.0) / 202, 6); // not 0.75
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

  it("a selected-but-absent metric contributes NOTHING and is counted as missing — never substituted", () => {
    // Regression: the old fallback substituted the card's first summary row, so one grid cell could average
    // cost_usd means into a judge pass rate — a wrong number with no marker.
    const cards = [
      card("a", { summary: [{ metric: "cost", count: 1, mean: 0.42 }] }),
      card("b", { summary: [{ metric: "judge", count: 4, mean: 0.75, passRate: 0.75 }] }),
    ];
    const r = computeAnalysis(cards, config({ metric: "judge" }));
    if (r.kind !== "grid") throw new Error("expected grid");
    const total = r.rows.reduce((sum, row) => sum + (row.missing ?? 0), 0);
    expect(total).toBe(1); // card "a" reported — visible, not smuggled into the aggregate
    for (const row of r.rows) expect(row.value === undefined || row.value === 0.75).toBe(true); // never 0.42-tainted
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
