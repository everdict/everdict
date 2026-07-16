import type {
  SecretMetaResponse,
  SecretUsageRef,
  SecretUsageResponse,
} from '@everdict/contracts/wire'
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

// --- secret usage (reverse index) — GET /secrets/usage: each workspace secret + its live reference sites ---
// kind = the referencing resource (drives the link target + a translated noun); field = which use holds the ref.
export const secretUsageKindSchema = z.enum([
  'harness',
  'runtime',
  'model',
  'mattermost',
  'imageRegistry',
  'traceSource',
  'proxy',
])
export const secretUsageFieldSchema = z.enum([
  'env',
  'trace-auth',
  'api-key',
  'cluster-token',
  'kubeconfig',
  'bot-token',
  'command-token',
  'registry-pull',
  'registry-push',
  'proxy-auth',
])
export const secretUsageRefSchema = z.object({
  kind: secretUsageKindSchema,
  field: secretUsageFieldSchema,
  label: z.string(),
  resourceId: z.string().optional(),
  version: z.string().optional(),
  detail: z.string().optional(),
})
// A workspace secret + its usage sites (refs=[] = referenced nowhere = orphan).
export const secretUsageSchema = secretMetaSchema.extend({ refs: z.array(secretUsageRefSchema) })
export const secretUsagesSchema = z.array(secretUsageSchema)

// Drift guards — bind the inferred outputs to the contract wire types (a rename/retype on either side fails typecheck).
type _refFwd = AssertAssignable<z.infer<typeof secretUsageRefSchema>, SecretUsageRef>
type _refBack = AssertAssignable<SecretUsageRef, z.infer<typeof secretUsageRefSchema>>
type _usageFwd = AssertAssignable<z.infer<typeof secretUsageSchema>, SecretUsageResponse>
type _usageBack = AssertAssignable<SecretUsageResponse, z.infer<typeof secretUsageSchema>>

export type SecretUsageMetaRef = SecretUsageRef
export type SecretUsageMeta = SecretUsageResponse

export type __secretDriftGuard = [_metaFwd, _metaBack, _refFwd, _refBack, _usageFwd, _usageBack]
