import { z } from "zod";

// Metric — 유저가 런타임에 정의하는 1급 채점 규칙(등록·버전·tenant 소유는 model/judge/runtime 와 동일 SSOT).
// kind:"threshold" — 이미 산출된 메트릭(결과 scores 의 한 항목: cost/latency/steps/judge/judge:<id> 등) 위에 합격
// 임계 규칙을 건다. 컨트롤플레인이 run 후 scores 위에 *post-hoc* 으로 적용한다(judge 와 동일 경로) — 러너/코드 변경
// 없이 새 메트릭/합격규칙을 추가·재정의할 수 있다. 비밀 없음(순수 규칙). 다른 kind(ratio/expression 등)는 union 확장.
export const ThresholdMetricSpecSchema = z.object({
  kind: z.literal("threshold"),
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  source: z.string(), // 임계를 걸 원본 메트릭 이름(예: "cost", "latency", "steps", "judge", "judge:<id>")
  op: z.enum(["lte", "gte", "lt", "gt", "eq"]),
  threshold: z.number(),
  metric: z.string().optional(), // 산출 메트릭 이름(기본 = id)
  tags: z.array(z.string()).default([]),
});
export type ThresholdMetricSpec = z.infer<typeof ThresholdMetricSpecSchema>;

export const MetricSpecSchema = z.discriminatedUnion("kind", [ThresholdMetricSpecSchema]);
export type MetricSpec = z.infer<typeof MetricSpecSchema>;
