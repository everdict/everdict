import { describe, expect, it } from "vitest";
import { type TrendCard, trendSeries } from "./trend.js";

// Time-ordered scorecards for one dataset (judge passRate varies 1.0 → 0.5 → 0.8).
const card = (id: string, createdAt: string, passRate: number | null, extra: Partial<TrendCard> = {}): TrendCard => ({
  id,
  dataset: { id: "pinch-core", version: "1.0.0" },
  harness: { id: "hermes-desktop", version: "1.0.0" },
  status: "succeeded",
  createdAt,
  summary: passRate === null ? [] : [{ metric: "judge", count: 10, mean: passRate, passRate }],
  ...extra,
});

describe("trendSeries", () => {
  it("time-ordered + delta/regression flag vs the first baseline", () => {
    const t = trendSeries(
      [
        card("b", "2026-06-02T00:00:00Z", 0.5), // regression (1.0 → 0.5)
        card("a", "2026-06-01T00:00:00Z", 1.0), // baseline (first)
        card("c", "2026-06-03T00:00:00Z", 0.8), // still below baseline → regression
      ],
      { datasetId: "pinch-core", metric: "judge", baseline: "first" },
    );
    expect(t.points.map((p) => p.scorecardId)).toEqual(["a", "b", "c"]); // createdAt asc
    expect(t.points.map((p) => p.score)).toEqual([1.0, 0.5, 0.8]);
    expect(t.points.map((p) => p.deltaVsBaseline)).toEqual([0, -0.5, expect.closeTo(-0.2, 5)]);
    expect(t.points.map((p) => p.regressed)).toEqual([false, true, true]);
  });

  it("previous baseline: each point vs its predecessor — c is 0.5→0.8 so not a regression", () => {
    const t = trendSeries(
      [
        card("a", "2026-06-01T00:00:00Z", 1.0),
        card("b", "2026-06-02T00:00:00Z", 0.5), // regression vs the predecessor (1.0)
        card("c", "2026-06-03T00:00:00Z", 0.8), // improvement vs the predecessor (0.5)
      ],
      { datasetId: "pinch-core", metric: "judge", baseline: "previous" },
    );
    expect(t.points.map((p) => p.regressed)).toEqual([false, true, false]);
    expect(t.points[2]?.deltaVsBaseline).toBeCloseTo(0.3, 5);
  });

  it("specified baseline (scorecardId)", () => {
    const t = trendSeries([card("a", "2026-06-01T00:00:00Z", 1.0), card("b", "2026-06-02T00:00:00Z", 0.5)], {
      datasetId: "pinch-core",
      metric: "judge",
      baseline: "b",
    });
    expect(t.points.find((p) => p.scorecardId === "a")?.deltaVsBaseline).toBeCloseTo(0.5, 5);
    expect(t.points.find((p) => p.scorecardId === "a")?.regressed).toBe(false);
  });

  it("dataset/harness/date/status filters + score null when the metric is missing (not a regression)", () => {
    const t = trendSeries(
      [
        card("a", "2026-06-01T00:00:00Z", 1.0),
        card("other", "2026-06-02T00:00:00Z", 0.1, { dataset: { id: "another", version: "1.0.0" } }), // different dataset
        card("running", "2026-06-02T00:00:00Z", 0.1, { status: "running" }), // incomplete
        card("nometric", "2026-06-03T00:00:00Z", null), // no metric
      ],
      { datasetId: "pinch-core", metric: "judge", from: "2026-06-01T00:00:00Z", to: "2026-06-05T00:00:00Z" },
    );
    expect(t.points.map((p) => p.scorecardId)).toEqual(["a", "nometric"]);
    expect(t.points[1]?.score).toBeNull();
    expect(t.points[1]?.regressed).toBe(false);
  });

  it("uses mean as the score when passRate is absent", () => {
    const c: TrendCard = {
      id: "x",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1.0.0" },
      status: "succeeded",
      createdAt: "2026-06-01T00:00:00Z",
      summary: [{ metric: "cost", count: 1, mean: 0.42 }], // no passRate
    };
    const t = trendSeries([c], { datasetId: "d", metric: "cost" });
    expect(t.points[0]?.score).toBe(0.42);
    expect(t.points[0]?.passRate).toBeNull();
  });
});
