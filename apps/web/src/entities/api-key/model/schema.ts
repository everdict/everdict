import { z } from 'zod'

// API key permission scopes (read|write|admin) — mirror of the control plane @everdict/auth API_KEY_SCOPES. Cumulative (admin=Full Access).
export const apiKeyScopes = ['read', 'write', 'admin'] as const
export const apiKeyScopeSchema = z.enum(apiKeyScopes)
export type ApiKeyScope = z.infer<typeof apiKeyScopeSchema>

// Mirror of GET /keys response — non-secret meta only (no plaintext/hash). prefix is an ak_abcd… identification hint.
// scopes unset (legacy/Full Access) means undefined = unlimited.
export const apiKeyMetaSchema = z.object({
  id: z.string(),
  prefix: z.string(),
  label: z.string().optional(),
  scopes: z.array(apiKeyScopeSchema).optional(),
  createdAt: z.string(),
})
export type ApiKeyMeta = z.infer<typeof apiKeyMetaSchema>

export const apiKeysSchema = z.array(apiKeyMetaSchema)

// Mirror of POST /keys request — scopes unset means Full Access (admin).
export const createApiKeyInputSchema = z.object({
  label: z.string().max(80).optional(),
  scopes: z.array(apiKeyScopeSchema).nonempty().optional(),
})
export type CreateApiKeyInput = z.infer<typeof createApiKeyInputSchema>

// POST /keys response — the plaintext (ak_…) is exposed here only once (never shown again).
export const createdApiKeySchema = z.object({ apiKey: z.string() })
export type CreatedApiKey = z.infer<typeof createdApiKeySchema>
