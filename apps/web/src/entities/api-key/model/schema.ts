import { z } from 'zod'

// GET /keys 응답 미러 — 비-비밀 메타만(평문/해시 없음). prefix 는 ak_abcd… 식별 힌트.
export const apiKeyMetaSchema = z.object({
  id: z.string(),
  prefix: z.string(),
  label: z.string().optional(),
  createdAt: z.string(),
})
export type ApiKeyMeta = z.infer<typeof apiKeyMetaSchema>

export const apiKeysSchema = z.array(apiKeyMetaSchema)

// POST /keys 응답 — 평문(ak_…)은 여기서 한 번만 노출된다(다시 못 봄).
export const createdApiKeySchema = z.object({ apiKey: z.string() })
export type CreatedApiKey = z.infer<typeof createdApiKeySchema>
