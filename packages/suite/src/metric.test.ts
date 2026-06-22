import type { MetricSpec, Score } from "@assay/core";
import { describe, expect, it } from "vitest";
import { evalMetric } from "./metric.js";

const threshold = (extra: Partial<MetricSpec> = {}): MetricSpec => ({
  kind: "threshold",
  id: "cost-budget",
  version: "1.0.0",
  source: "cost",
  op: "lte",
  threshold: 0.5,
  tags: [],
  ...extra,
});

const scores: Score[] = [
  { graderId: "cost", metric: "cost", value: 0.42 },
  { graderId: "judge", metric: "judge", value: 0.9, pass: true },
];

describe("evalMetric (threshold)", () => {
  it("source 값에 op 임계 적용 → pass (cost 0.42 <= 0.5)", () => {
    const s = evalMetric(threshold(), scores);
    expect(s).toBeDefined();
    expect(s?.metric).toBe("cost-budget");
    expect(s?.value).toBe(0.42);
    expect(s?.pass).toBe(true);
  });

  it("임계 초과 → fail (cost 0.42 > 0.3)", () => {
    const s = evalMetric(threshold({ threshold: 0.3 }), scores);
    expect(s?.pass).toBe(false);
  });

  it("gte 로 judge 품질 게이트(0.9 >= 0.7 → pass), 산출 메트릭 이름 override", () => {
    const s = evalMetric(
      threshold({ id: "quality-gate", source: "judge", op: "gte", threshold: 0.7, metric: "quality" }),
      scores,
    );
    expect(s?.metric).toBe("quality");
    expect(s?.pass).toBe(true);
  });

  it("source 메트릭이 결과에 없으면 undefined(스킵)", () => {
    expect(evalMetric(threshold({ source: "latency" }), scores)).toBeUndefined();
  });
});
