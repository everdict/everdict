import { describe, expect, it } from "vitest";
import { type TrendCard, trendSeries } from "./trend.js";
import { DEFAULT_VERDICT_POLICY_V1, verdictPolicyDigest } from "./verdict-policy.js";

// The pre-sha256 sealer, reproduced verbatim (see verdict-policy.test.ts) — a legacy stamp in these tests is
// one the OLD code would really have written.
function legacyFnvOf(document: unknown): string {
  const canonicalize = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
    if (value !== null && typeof value === "object")
      return `{${Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
        .join(",")}}`;
    return JSON.stringify(value);
  };
  const text = canonicalize(document);
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

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

describe("trend direction (sign-as-verdict sweep)", () => {
  const card = (id: string, createdAt: string, metric: string, mean: number, passRate?: number) => ({
    id,
    dataset: { id: "d", version: "1" },
    harness: { id: "h", version: "1" },
    status: "succeeded",
    createdAt,
    summary: [{ metric, count: 3, mean, ...(passRate !== undefined ? { passRate } : {}) }],
  });

  it("a cost_usd DROP is not a regression — declared lower_is_better flips the reading", () => {
    const t = trendSeries(
      [card("a", "2026-01-01T00:00:00Z", "cost_usd", 1.0), card("b", "2026-01-02T00:00:00Z", "cost_usd", 0.5)],
      { datasetId: "d", metric: "cost_usd" },
    );
    expect(t.direction).toBe("lower_is_better");
    expect(t.points[1]?.regressed).toBe(false); // cheaper is BETTER
    // ...and a cost INCREASE is the regression
    const up = trendSeries(
      [card("a", "2026-01-01T00:00:00Z", "cost_usd", 0.5), card("b", "2026-01-02T00:00:00Z", "cost_usd", 1.0)],
      { datasetId: "d", metric: "cost_usd" },
    );
    expect(up.points[1]?.regressed).toBe(true);
  });

  it("an undeclared mean-only metric has no direction and flags nothing", () => {
    const t = trendSeries(
      [card("a", "2026-01-01T00:00:00Z", "custom", 1.0), card("b", "2026-01-02T00:00:00Z", "custom", 0.1)],
      { datasetId: "d", metric: "custom" },
    );
    expect(t.direction).toBeUndefined();
    expect(t.points.every((p) => !p.regressed)).toBe(true);
  });
});

describe("trend policy gate", () => {
  const c = (
    id: string,
    createdAt: string,
    passRate: number,
    ref?: { id: string; version: string; digest: string },
  ) => ({
    id,
    dataset: { id: "d", version: "1" },
    harness: { id: "h", version: "1" },
    status: "succeeded",
    createdAt,
    summary: [{ metric: "tests_pass", count: 3, mean: passRate, passRate }],
    ...(ref ? { verdictPolicy: ref } : {}),
  });
  const composed = (digest: string) => ({ id: "composed", version: digest.slice(0, 8), digest });

  it("a drop across a policy change is disclosed, never flagged as a regression", () => {
    const t = trendSeries(
      [c("a", "2026-01-01T00:00:00Z", 1.0, composed("aaa")), c("b", "2026-01-02T00:00:00Z", 0.5, composed("bbb"))],
      {
        datasetId: "d",
        metric: "tests_pass",
      },
    );
    expect(t.policyMixed).toBe(true);
    expect(t.points[1]?.policyDiffers).toBe(true);
    expect(t.points[1]?.regressed).toBe(false); // different rules produced the two rates
    // the same drop under ONE policy IS a regression
    const same = trendSeries(
      [c("a", "2026-01-01T00:00:00Z", 1.0, composed("aaa")), c("b", "2026-01-02T00:00:00Z", 0.5, composed("aaa"))],
      {
        datasetId: "d",
        metric: "tests_pass",
      },
    );
    expect(same.policyMixed).toBeUndefined();
    expect(same.points[1]?.regressed).toBe(true);
  });

  it("one rule-set across the digest-era boundary is ONE policy — the migration never suppresses a regression", () => {
    // Regression: identity compared raw stamp strings, so an FNV-stamped v1 card, a sha256-stamped v1 card
    // and an unstamped pre-mig card read as THREE policies — policyMixed flagged, the real 1.0 → 0.5 drop
    // never marked regressed, exactly across the boundary the dual-read resolver exists to bridge.
    const fnvV1 = { id: "authority-ladder", version: "1.0.0", digest: legacyFnvOf(DEFAULT_VERDICT_POLICY_V1) };
    const shaV1 = { id: "authority-ladder", version: "1.0.0", digest: verdictPolicyDigest(DEFAULT_VERDICT_POLICY_V1) };
    const t = trendSeries(
      [
        c("legacy", "2026-01-01T00:00:00Z", 1.0, fnvV1),
        c("migrated", "2026-01-02T00:00:00Z", 0.5, shaV1),
        c("prestamp", "2026-01-03T00:00:00Z", 0.6), // no stamp at all — judged under the same frozen v1 ladder
      ],
      { datasetId: "d", metric: "tests_pass" },
    );
    expect(t.policyMixed).toBeUndefined();
    expect(t.points[1]?.policyDiffers).toBeUndefined();
    expect(t.points[1]?.regressed).toBe(true); // the drop is real and the boundary does not hide it
    expect(t.points[2]?.regressed).toBe(true);
  });
});
