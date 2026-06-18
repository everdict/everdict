import { z } from 'zod'

// 컨트롤플레인 JudgeSpec(Agent Judge)의 클라이언트 미러. 웹은 HTTP 로만 결합 — 백엔드 패키지 비의존.
// GET /judges 응답: 테넌트가 보는 judge 목록(소유 + _shared 기본 judge).
export const judgeSummarySchema = z.object({
  id: z.string(),
  owner: z.string(),
  versions: z.array(z.string()),
})
export type JudgeSummary = z.infer<typeof judgeSummarySchema>
export const judgesSchema = z.array(judgeSummarySchema)

// 전체 JudgeSpec(model | harness) — 표시용 느슨 미러(나머지 passthrough).
export const judgeSpecSchema = z
  .object({
    kind: z.enum(['model', 'harness']),
    id: z.string(),
    version: z.string(),
    description: z.string().optional(),
    // model 종류
    provider: z.string().optional(),
    model: z.string().optional(),
    rubric: z.string().optional(),
    inputs: z.array(z.string()).optional(),
    passThreshold: z.number().optional(),
    // harness 종류
    harness: z.object({ id: z.string(), version: z.string() }).optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough()
export type JudgeSpec = z.infer<typeof judgeSpecSchema>
