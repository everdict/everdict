import { z } from 'zod'

// API 키 권한 범위(read|write|admin) — 컨트롤플레인 @assay/auth 의 API_KEY_SCOPES 미러. 누적(admin=Full Access).
export const apiKeyScopes = ['read', 'write', 'admin'] as const
export const apiKeyScopeSchema = z.enum(apiKeyScopes)
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>

// GET /keys 응답 미러 — 비-비밀 메타만(평문/해시 없음). prefix 는 ak_abcd… 식별 힌트.
// scopes 미지정(레거시/Full Access)이면 undefined = 무제한.
export const apiKeyMetaSchema = z.object({
  id: z.string(),
  prefix: z.string(),
  label: z.string().optional(),
  scopes: z.array(apiKeyScopeSchema).optional(),
  createdAt: z.string(),
})
export type ApiKeyMeta = z.infer<typeof apiKeyMetaSchema>

export const apiKeysSchema = z.array(apiKeyMetaSchema)

// POST /keys 요청 미러 — scopes 미지정이면 Full Access(admin).
export const createApiKeyInputSchema = z.object({
  label: z.string().max(80).optional(),
  scopes: z.array(apiKeyScopeSchema).nonempty().optional(),
})
export type CreateApiKeyInput = z.infer<typeof createApiKeyInputSchema>

// POST /keys 응답 — 평문(ak_…)은 여기서 한 번만 노출된다(다시 못 봄).
export const createdApiKeySchema = z.object({ apiKey: z.string() })
export type CreatedApiKey = z.infer<typeof createdApiKeySchema>
