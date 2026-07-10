import type { SecretMetaResponse } from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
// Client mirror of the control-plane GET /secrets response — name + updated time + scope.
// scope: "workspace" (shared, admin-managed) | "user" (my personal, self-managed). Values are write-only (never returned after saving).
export const secretScopeSchema = z.enum(['user', 'workspace'])

export const secretMetaSchema = z.object({
  name: z.string(),
  updatedAt: z.string(),
  scope: secretScopeSchema.default('workspace'),
})

export const secretsSchema = z.array(secretMetaSchema)

// Drift guards — identical-shape entity (name/updatedAt/scope), so the guard is bidirectional. The `.default`
// on scope is an input-only concern (zod default); the inferred OUTPUT scope stays 'user'|'workspace', matching
// the wire enum both ways. A renamed/added field or a widened scope on EITHER side fails the web typecheck.
type AssertAssignable<A extends B, B> = A
type WebSecretMeta = z.infer<typeof secretMetaSchema>
type _metaFwd = AssertAssignable<WebSecretMeta, SecretMetaResponse>
type _metaBack = AssertAssignable<SecretMetaResponse, WebSecretMeta>

// Exported names alias the contract types (consumers untouched: same SecretMeta / SecretScope identifiers).
export type SecretMeta = SecretMetaResponse
export type SecretScope = SecretMetaResponse['scope']

export type __secretDriftGuard = [_metaFwd, _metaBack]
