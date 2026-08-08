import type { ProductRecord, ReleaseRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { Product } from "./product.js";
import { type SeriesScorecardPoint, releaseReadiness, watchedSeries } from "./readiness.js";
import { Release } from "./release.js";

const NOW = "2026-08-08T00:00:00.000Z";

function product(): ProductRecord {
  return Product.newProduct({
    id: "prod-1",
    tenant: "acme",
    name: "Support Copilot",
    series: [
      { key: "quality", label: "Quality", dataset: { id: "d" }, harness: { id: "h" }, judges: [] },
      { key: "latency", label: "Latency", dataset: { id: "d2" }, harness: { id: "h" }, judges: [] },
    ],
    createdBy: "dana",
    now: NOW,
  });
}

function release(seriesKeys?: string[]): ReleaseRecord {
  return Release.newRelease({
    id: "rel-1",
    tenant: "acme",
    productId: "prod-1",
    name: "2026.3",
    ...(seriesKeys !== undefined ? { seriesKeys } : {}),
    productSeriesKeys: ["quality", "latency"],
    createdBy: "dana",
    now: NOW,
  });
}

function point(scorecardId: string, passRate?: number): SeriesScorecardPoint {
  return { scorecardId, ...(passRate !== undefined ? { passRate } : {}), createdAt: NOW };
}

describe("releaseReadiness — pure arithmetic over what the caller fetched", () => {
  it("watches every product series by default, and only the selection when one was made", () => {
    expect(watchedSeries(product(), release()).map((series) => series.key)).toEqual(["quality", "latency"]);
    expect(watchedSeries(product(), release(["latency"])).map((series) => series.key)).toEqual(["latency"]);
  });

  it("flags a series regressed only when both rates are measured and the latest fell below the baseline", () => {
    const readiness = releaseReadiness(
      release(),
      product(),
      new Map([
        ["quality", point("sc-2", 0.6)],
        ["latency", point("sc-4", 0.9)],
      ]),
      new Map([
        ["quality", point("sc-1", 0.8)],
        ["latency", point("sc-3", 0.9)],
      ]),
      0,
    );
    expect(readiness.regressedSeries).toEqual(["quality"]);
    expect(readiness.ready).toBe(false);
  });

  it("reads absence of evidence as not regressed — a series that never ran cannot block a release", () => {
    // Given one series with no runs at all and one whose baseline has no measured rate
    const readiness = releaseReadiness(
      release(),
      product(),
      new Map([["latency", point("sc-2", 0.5)]]),
      new Map([["latency", point("sc-1")]]),
      0,
    );
    // Then neither reads as a regression, and the release is ready
    expect(readiness.regressedSeries).toEqual([]);
    expect(readiness.ready).toBe(true);
    expect(readiness.series.find((series) => series.key === "quality")?.latest).toBeUndefined();
  });

  it("stays not-ready while linked issues are open even when every series holds", () => {
    const readiness = releaseReadiness(release(), product(), new Map(), new Map(), 2);
    expect(readiness.openIssues).toBe(2);
    expect(readiness.ready).toBe(false);
  });
});
