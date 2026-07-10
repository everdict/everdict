import type { ApiKeyMetaResponse, CreatedApiKeyResponse } from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.

// API key permission scopes (read|write|admin) — mirror of the control plane @everdict/auth API_KEY_SCOPES. Cumulative (admin=Full Access).
// The wire types `scopes` as a loose `string[]`; the web narrows it to this enum. ApiKeyScope/CreateApiKeyInput
// have no wire counterpart (a client-only narrower type + a request DTO) — they stay LOCAL.
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

export const apiKeysSchema = z.array(apiKeyMetaSchema)

// Mirror of POST /keys request — scopes unset means Full Access (admin). Request DTO — no response counterpart, stays local.
export const createApiKeyInputSchema = z.object({
  label: z.string().max(80).optional(),
  scopes: z.array(apiKeyScopeSchema).nonempty().optional(),
})
export type CreateApiKeyInput = z.infer<typeof createApiKeyInputSchema>

// POST /keys response — the plaintext (ak_…) is exposed here only once (never shown again). Identical to the wire.
export const createdApiKeySchema = z.object({ apiKey: z.string() })

// Drift guards. ApiKeyMeta is NOT identical-shape: the web narrows `scopes` from the wire's `string[]` to the
// ApiKeyScope enum, so a full bidirectional guard would (correctly) reject the reverse. Instead:
//   _metaFwd     — web ⊆ wire: the narrowed scopes stay assignable, and a required-field retype/rename fails here.
//   _metaFlatBack — every IDENTICAL flat field the web models (scopes excluded) must exist on the wire with an
//                   assignable type: catches renaming an optional wire field the web models (_metaFwd alone misses it).
// CreatedApiKey is identical-shape ({apiKey}) so it guards bidirectionally.
type AssertAssignable<A extends B, B> = A
type WebApiKeyMeta = z.infer<typeof apiKeyMetaSchema>
type WebApiKeyMetaFlat = Omit<WebApiKeyMeta, 'scopes'>
type WireApiKeyMetaFlat = Omit<ApiKeyMetaResponse, 'scopes'>
type _metaFwd = AssertAssignable<WebApiKeyMetaFlat, WireApiKeyMetaFlat>
type _metaFlatBack = AssertAssignable<
  Pick<WireApiKeyMetaFlat, keyof WebApiKeyMetaFlat>,
  WebApiKeyMetaFlat
>
// scopes must stay a subtype of the wire's element type (a narrowing, not a drift).
type _scopesGuard = AssertAssignable<
  NonNullable<WebApiKeyMeta['scopes']>,
  NonNullable<ApiKeyMetaResponse['scopes']>
>
type WebCreatedApiKey = z.infer<typeof createdApiKeySchema>
type _createdFwd = AssertAssignable<WebCreatedApiKey, CreatedApiKeyResponse>
type _createdBack = AssertAssignable<CreatedApiKeyResponse, WebCreatedApiKey>

// The exported ApiKeyMeta = the wire DTO's flat fields + the web's narrowed `scopes` view.
export type ApiKeyMeta = WireApiKeyMetaFlat & { scopes?: ApiKeyScope[] }
export type CreatedApiKey = CreatedApiKeyResponse

export type __apiKeyDriftGuard = [_metaFwd, _metaFlatBack, _scopesGuard, _createdFwd, _createdBack]
