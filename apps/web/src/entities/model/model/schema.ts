import { z } from 'zod'

// 컨트롤플레인 ModelSpec(추론/판정 모델)의 클라이언트 미러. 웹은 HTTP 로만 결합 — 백엔드 패키지 비의존.
// GET /models 응답: 테넌트가 보는 모델 목록(소유 + _shared 공용).
export const modelSummarySchema = z.object({
  id: z.string(),
  owner: z.string(),
  versions: z.array(z.string()),
})
export type ModelSummary = z.infer<typeof modelSummarySchema>
export const modelsSchema = z.array(modelSummarySchema)

// 전체 ModelSpec — 표시용 느슨 미러(나머지 passthrough).
export const modelSpecSchema = z
  .object({
    id: z.string(),
    version: z.string(),
    description: z.string().optional(),
    provider: z.string(),
    model: z.string(),
    baseUrl: z.string().optional(),
    params: z
      .object({ temperature: z.number().optional(), maxTokens: z.number().optional() })
      .optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough()
export type ModelSpec = z.infer<typeof modelSpecSchema>
