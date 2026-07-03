import { z } from 'zod'

// 컨트롤플레인 데이터셋의 클라이언트 미러. 웹은 HTTP 로만 결합 — 백엔드 패키지 비의존.

// 데이터셋 출처 — 어떻게 만들어졌나(레시피/카탈로그/인라인 spec). 데이터셋 → 만든 레시피 역링크용.
export const datasetProvenanceSchema = z.object({
  via: z.enum(['recipe', 'catalog', 'spec']),
  id: z.string(),
  version: z.string().optional(),
})
export type DatasetProvenance = z.infer<typeof datasetProvenanceSchema>

// GET /datasets 응답 한 항목(DatasetListEntry 미러): 하나의 id(여러 불변 버전)를 목록 화면용 메타로 요약.
// 내용(caseCount/description/tags/producedBy)은 최신 버전에서, 생성자·시각은 등록 이력에서.
// 과거/시드 레코드는 메타가 없을 수 있어 대부분 optional.
export const datasetSummarySchema = z.object({
  id: z.string(),
  owner: z.string(),
  versions: z.array(z.string()),
  latestVersion: z.string().optional(),
  caseCount: z.number().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  producedBy: datasetProvenanceSchema.optional(),
  createdBy: z.string().optional(), // 최초 등록 버전의 생성자 subject(시드/_shared 는 없음)
  createdAt: z.string().optional(), // 최초 버전 등록 시각(ISO)
  updatedAt: z.string().optional(), // 최근 버전 등록 시각(ISO)
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
    timeoutSec: z.number().optional(), // 케이스 시간 예산(초) — 있으면 표시
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
  producedBy: datasetProvenanceSchema.optional(), // 인입 출처(있으면). 과거 데이터셋은 미설정.
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
