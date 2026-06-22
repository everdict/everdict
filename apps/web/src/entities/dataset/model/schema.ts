import { z } from 'zod'

// 컨트롤플레인 데이터셋의 클라이언트 미러. 웹은 HTTP 로만 결합 — 백엔드 패키지 비의존.
// GET /datasets 응답: 테넌트가 보는 데이터셋 목록(자기 소유 + _shared 벤치마크).
export const datasetSummarySchema = z.object({
  id: z.string(),
  owner: z.string(),
  versions: z.array(z.string()),
})
export type DatasetSummary = z.infer<typeof datasetSummarySchema>
export const datasetsSchema = z.array(datasetSummarySchema)

// eval 케이스(느슨한 미러 — UI 표시에 필요한 필드만, 나머지는 passthrough).
export const datasetCaseSchema = z
  .object({
    id: z.string(),
    task: z.string(),
    env: z.object({ kind: z.string() }).passthrough().optional(),
    graders: z.array(z.object({ id: z.string() }).passthrough()).default([]),
    tags: z.array(z.string()).default([]),
  })
  .passthrough()
export type DatasetCase = z.infer<typeof datasetCaseSchema>

// GET /datasets/:id/versions/:version 응답: 전체 데이터셋(케이스 포함).
export const datasetSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  cases: z.array(datasetCaseSchema),
  tags: z.array(z.string()).default([]),
})
export type Dataset = z.infer<typeof datasetSchema>

// GET /datasets/:id/diff?base&candidate 응답: 버전 간 구조적 diff(컨트롤플레인 DatasetDiff 미러).
const fieldChangeSchema = z.object({
  field: z.string(),
  before: z.string(),
  after: z.string(),
})
export type DatasetFieldChange = z.infer<typeof fieldChangeSchema>
const caseRefSchema = z.object({ id: z.string(), task: z.string() })
export const datasetDiffSchema = z.object({
  id: z.string(),
  base: z.string(),
  candidate: z.string(),
  meta: z.array(fieldChangeSchema),
  added: z.array(caseRefSchema),
  removed: z.array(caseRefSchema),
  changed: z.array(z.object({ id: z.string(), changes: z.array(fieldChangeSchema) })),
  unchanged: z.number(),
  summary: z.object({
    added: z.number(),
    removed: z.number(),
    changed: z.number(),
    unchanged: z.number(),
  }),
})
export type DatasetDiff = z.infer<typeof datasetDiffSchema>
