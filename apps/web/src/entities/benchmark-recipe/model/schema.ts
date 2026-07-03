import { z } from 'zod'

// 컨트롤플레인 벤치마크 레시피(BenchmarkAdapterSpec)의 클라이언트 미러. 웹은 HTTP 로만 결합 — 백엔드 패키지 비의존.
// 레시피 = 데이터셋을 만들어내는 재사용 어댑터(source + mapping + 채점 템플릿). 데이터셋 자체가 아님.

// GET /benchmark-recipes 목록 항목(경량 — id/versions/owner 만).
export const recipeListItemSchema = z.object({
  id: z.string(),
  owner: z.string(),
  versions: z.array(z.string()),
})
export type RecipeListItem = z.infer<typeof recipeListItemSchema>
export const recipeListSchema = z.array(recipeListItemSchema)

// source — huggingface(dataset/config/split/gated) 또는 jsonl. 확장 대비 passthrough.
export const recipeSourceSchema = z
  .object({
    kind: z.string(),
    dataset: z.string().optional(),
    config: z.string().optional(),
    split: z.string().optional(),
    gated: z.boolean().optional(),
  })
  .passthrough()
export type RecipeSource = z.infer<typeof recipeSourceSchema>

// mapping — 어떤 소스 필드가 케이스의 id/task/answer/… 가 되는지. 필드가 많고 늘어나므로 느슨한 레코드로.
export const recipeMappingSchema = z.record(z.string(), z.unknown())

// grader 템플릿 — 행별 {field} 보간으로 per-case grader 구성.
export const recipeGraderTemplateSchema = z
  .object({ id: z.string(), config: z.record(z.string(), z.unknown()).optional() })
  .passthrough()

// origin — 원본 벤치마크 출처(홈페이지/논문/코드/데이터/공식 리더보드 등). 표시용 메타데이터.
export const recipeOriginSchema = z
  .object({
    homepage: z.string().optional(),
    paper: z.string().optional(),
    code: z.string().optional(),
    data: z.string().optional(),
    leaderboard: z.string().optional(),
    authors: z.string().optional(),
    license: z.string().optional(),
    citation: z.string().optional(),
    taskType: z.string().optional(),
  })
  .partial()
export type RecipeOrigin = z.infer<typeof recipeOriginSchema>

// GET /benchmark-recipes/:id/versions/:version — 전체 스펙(상세 표시용).
export const recipeSpecSchema = z
  .object({
    id: z.string(),
    version: z.string(),
    description: z.string().optional(),
    category: z.string().default('qa'),
    origin: recipeOriginSchema.optional(),
    source: recipeSourceSchema,
    mapping: recipeMappingSchema.default({}),
    graderTemplates: z.array(recipeGraderTemplateSchema).optional(),
  })
  .passthrough()
export type RecipeSpec = z.infer<typeof recipeSpecSchema>
