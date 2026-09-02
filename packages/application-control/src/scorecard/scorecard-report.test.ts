import type { Dataset, ScorecardRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { citableReport } from "./scorecard-report.js";

// ── EXPORT WHAT IS CITABLE, REFUSE WHAT IS NOT (benchmark-evidence-spec.md §4) ────────────────────────
const record = {
  id: "sc-1",
  tenant: "acme",
  dataset: { id: "gaia", version: "1" },
  harness: { id: "agent", version: "1.0.0" },
  status: "succeeded",
  createdAt: "2026-09-02T00:00:00.000Z",
  manifest: {
    dataset: { id: "gaia", version: "1", digest: "sha256:ds" },
    harness: { id: "agent", version: "1.0.0", specDigest: "sha256:spec" },
    identityVersion: 3,
  },
  scorecard: {
    results: [
      { caseId: "c1", trial: 0, scores: [{ graderId: "g", metric: "answer_match", value: 1, pass: true }] },
      { caseId: "c2", trial: 0, scores: [{ graderId: "g", metric: "answer_match", value: 0, pass: false }] },
    ],
  },
} as unknown as ScorecardRecord;
type Scoring = NonNullable<Dataset["producedBy"]>["scoring"];
const datasetWith = (scoring: Scoring) =>
  ({
    id: "gaia",
    version: "1",
    cases: [],
    tags: [],
    producedBy: scoring === undefined ? {} : { scoring },
  }) as unknown as Dataset;
const deps = (scoring: Scoring) => ({
  scorecards: { get: async () => record },
  datasets: { get: async () => datasetWith(scoring) },
});

describe("citableReport", () => {
  it("exports an official scorecard with the identities that make it a number", async () => {
    const report = await citableReport(
      deps({ kind: "official", officialEvaluator: "gaia-scorer" }),
      "acme",
      "sc-1",
      undefined,
      {
        allowProxy: false,
        now: () => "t",
      },
    );
    expect(report).toMatchObject({
      kind: "everdict-scorecard-report",
      benchmark: {
        dataset: { id: "gaia", version: "1", digest: "sha256:ds" },
        scoring: { kind: "official", officialEvaluator: "gaia-scorer" },
      },
      harness: { id: "agent", version: "1.0.0", specDigest: "sha256:spec" },
      manifest: { identityVersion: 3 },
    });
    expect(report.cases.map((c) => [c.caseId, c.verdict])).toEqual([
      ["c1", "pass"],
      ["c2", "fail"],
    ]);
  });
  it("refuses a proxy or unstated scoring unless asked by name, then labels the export", async () => {
    await expect(
      citableReport(
        deps({ kind: "proxy", approximates: "judge stands in for the official DB check" }),
        "acme",
        "sc-1",
        undefined,
        { allowProxy: false },
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      citableReport(deps(undefined), "acme", "sc-1", undefined, { allowProxy: false }),
    ).rejects.toMatchObject({ status: 400 });
    const proxy = await citableReport(
      deps({ kind: "proxy", approximates: "judge stands in" }),
      "acme",
      "sc-1",
      undefined,
      { allowProxy: true },
    );
    expect(proxy.benchmark.scoring).toEqual({ kind: "proxy", approximates: "judge stands in" });
    const unstated = await citableReport(deps(undefined), "acme", "sc-1", undefined, { allowProxy: true });
    expect(unstated.benchmark.scoring).toEqual({ kind: "unstated" });
  });
  it("another workspace's or an unfinished scorecard is not citable", async () => {
    await expect(
      citableReport(deps({ kind: "official" }), "other", "sc-1", undefined, { allowProxy: true }),
    ).rejects.toMatchObject({ status: 404 });
    const running = {
      scorecards: { get: async () => ({ ...record, status: "running" }) as ScorecardRecord },
      datasets: deps({ kind: "official" }).datasets,
    };
    await expect(citableReport(running, "acme", "sc-1", undefined, { allowProxy: true })).rejects.toMatchObject({
      status: 400,
    });
  });
});
