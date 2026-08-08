import type { ProductRecord, ProductSeries, ReleaseRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { Product } from "./product.js";
import { type SeriesGateReading, type SeriesScorecardPoint, releaseReadiness, watchedSeries } from "./readiness.js";
import { Release } from "./release.js";

const NOW = "2026-08-08T00:00:00.000Z";

function product(over: Partial<ProductSeries>[] = []): ProductRecord {
  const base: ProductSeries[] = [
    { key: "quality", label: "Quality", dataset: { id: "d" }, harness: { id: "h" }, judges: [] },
    { key: "latency", label: "Latency", dataset: { id: "d2" }, harness: { id: "h" }, judges: [] },
  ];
  return Product.newProduct({
    id: "prod-1",
    tenant: "acme",
    name: "Support Copilot",
    series: base.map((s, i) => ({ ...s, ...(over[i] ?? {}) })),
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

const gate = (verdict: SeriesGateReading["verdict"], reasons?: string[]): SeriesGateReading => ({
  verdict,
  ...(reasons ? { reasons } : {}),
});

describe("releaseReadiness — the SCORECARD GATE's verdicts, composed; never a second truth", () => {
  it("watches every product series by default, and only the selection when one was made", () => {
    expect(watchedSeries(product(), release()).map((series) => series.key)).toEqual(["quality", "latency"]);
    expect(watchedSeries(product(), release(["latency"])).map((series) => series.key)).toEqual(["latency"]);
  });

  it("carries the gate's verdict per series — a block blocks, a pass passes, and the reasons ride along", () => {
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
      new Map([
        ["quality", gate("block", ["1 regression over the shared cases"])],
        ["latency", gate("pass")],
      ]),
      0,
    );
    expect(readiness.regressedSeries).toEqual(["quality"]);
    expect(readiness.series.find((s) => s.key === "quality")).toMatchObject({
      verdict: "block",
      regressed: true,
      reasons: ["1 regression over the shared cases"],
    });
    expect(readiness.series.find((s) => s.key === "latency")).toMatchObject({ verdict: "pass", regressed: false });
    expect(readiness.ready).toBe(false);
  });

  it("NOT EVALUATED IS NEVER GREEN — a required series that never ran blocks the release (arch-review 7 P0)", () => {
    // The pre-verdict arithmetic read "absence of evidence as not regressed" and shipped on zero
    // evaluations — the exact false green this rewrite exists to kill.
    const readiness = releaseReadiness(
      release(),
      product(),
      new Map([["latency", point("sc-2", 0.5)]]),
      new Map([["latency", point("sc-1", 0.5)]]),
      new Map([["latency", gate("pass")]]),
      0,
    );
    expect(readiness.series.find((s) => s.key === "quality")).toMatchObject({
      verdict: "not_evaluated",
      regressed: true,
    });
    expect(readiness.regressedSeries).toEqual(["quality"]);
    expect(readiness.ready).toBe(false);
  });

  it("opting a series out of the gate is the EXPLICIT requiredForRelease policy — never inferred from absence", () => {
    const readiness = releaseReadiness(
      release(),
      product([{ requiredForRelease: false }]), // quality declared non-gating — a recorded product choice
      new Map([["latency", point("sc-2", 0.5)]]),
      new Map([["latency", point("sc-1", 0.5)]]),
      new Map([["latency", gate("pass")]]),
      0,
    );
    expect(readiness.series.find((s) => s.key === "quality")).toMatchObject({
      verdict: "not_evaluated",
      regressed: false, // informational, not blocking — because the product SAID so
    });
    expect(readiness.ready).toBe(true);
  });

  it("the first ship has no baseline — evidence exists, nothing to regress from, and it does not block", () => {
    const readiness = releaseReadiness(
      release(["quality"]),
      product(),
      new Map([["quality", point("sc-1", 0.9)]]),
      new Map(),
      new Map(),
      0,
    );
    expect(readiness.series[0]).toMatchObject({ verdict: "no_baseline", regressed: false });
    expect(readiness.ready).toBe(true);
  });

  it("a comparable pair with NO gate reading refuses — the seam being unconfigured is never a pass", () => {
    const readiness = releaseReadiness(
      release(["quality"]),
      product(),
      new Map([["quality", point("sc-2", 0.9)]]),
      new Map([["quality", point("sc-1", 0.8)]]),
      new Map(), // no gate reading handed in
      0,
    );
    expect(readiness.series[0]).toMatchObject({ verdict: "not_comparable", regressed: true });
    expect(readiness.ready).toBe(false);
  });

  it("blocked_missing and not_comparable from the gate block exactly like a regression", () => {
    const readiness = releaseReadiness(
      release(),
      product(),
      new Map([
        ["quality", point("sc-2", 0.9)],
        ["latency", point("sc-4", 0.9)],
      ]),
      new Map([
        ["quality", point("sc-1", 0.8)],
        ["latency", point("sc-3", 0.9)],
      ]),
      new Map([
        ["quality", gate("blocked_missing", ["the candidate skipped 2 of the baseline's cases"])],
        ["latency", gate("not_comparable", ["experiment identity confounded: judge_set"])],
      ]),
      0,
    );
    expect(readiness.regressedSeries).toEqual(["quality", "latency"]);
    expect(readiness.ready).toBe(false);
  });

  it("stays not-ready while linked issues are open even when every series holds", () => {
    const readiness = releaseReadiness(release(), product(), new Map(), new Map(), new Map(), 2);
    expect(readiness.openIssues).toBe(2);
    expect(readiness.ready).toBe(false);
  });
});
