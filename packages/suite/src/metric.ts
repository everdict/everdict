import type { MetricSpec, Score } from "@assay/core";

// 등록된 MetricSpec 을 *이미 산출된 결과 scores* 위에 적용 → 새 Score(합격 규칙). 순수 — trace/코드/러너 무관.
// threshold: source 메트릭의 value 에 op 임계를 걸어 pass 판정. source 가 결과에 없으면 undefined(스킵).
const OPS: Record<MetricSpec["op"], (v: number, t: number) => boolean> = {
  lte: (v, t) => v <= t,
  gte: (v, t) => v >= t,
  lt: (v, t) => v < t,
  gt: (v, t) => v > t,
  eq: (v, t) => v === t,
};

export function evalMetric(spec: MetricSpec, scores: Score[]): Score | undefined {
  const src = scores.find((s) => s.metric === spec.source);
  if (!src) return undefined; // 원본 메트릭이 결과에 없음 → 적용 불가(조용히 스킵)
  const pass = OPS[spec.op](src.value, spec.threshold);
  return {
    graderId: spec.id,
    metric: spec.metric ?? spec.id,
    value: src.value,
    pass,
    detail: `[metric ${spec.id}] ${spec.source} ${spec.op} ${spec.threshold} → ${pass ? "pass" : "fail"} (${src.value})`,
  };
}
