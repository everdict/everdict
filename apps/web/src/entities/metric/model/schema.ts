import { z } from 'zod'

// 컨트롤플레인 MetricSpec(런타임 정의 합격규칙)의 클라이언트 미러. 웹은 HTTP 로만 결합 — 백엔드 패키지 비의존.
// GET /metrics 응답: 테넌트가 보는 메트릭 목록(소유 + _shared 공용).
export const metricSummarySchema = z.object({
  id: z.string(),
  owner: z.string(),
  versions: z.array(z.string()),
})
export type MetricSummary = z.infer<typeof metricSummarySchema>
export const metricsSchema = z.array(metricSummarySchema)

// 전체 MetricSpec(threshold) — 표시용 느슨 미러(나머지 passthrough).
export const metricSpecSchema = z
  .object({
    kind: z.enum(['threshold']),
    id: z.string(),
    version: z.string(),
    description: z.string().optional(),
    source: z.string().optional(),
    op: z.enum(['lte', 'gte', 'lt', 'gt', 'eq']).optional(),
    threshold: z.number().optional(),
    metric: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough()
export type MetricSpec = z.infer<typeof metricSpecSchema>
