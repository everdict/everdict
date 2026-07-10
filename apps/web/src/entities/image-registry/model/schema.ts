import type {
  ImageRegistryRoster,
  ImageRegistryUpsertResult,
  ImageRegistryView,
} from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
// Client mirror of the control plane /workspace/image-registries response — workspace image registries (BYO, multiple).
// No secrets: pull/pushSecretName are SecretStore name references, not values. imagePrefix = "host[/namespace]/"
// (for classification badges and assembling the everdict image push target ref).
export const imageRegistryConfigSchema = z.object({
  name: z.string(), // registry identifier — the key for upsert/delete/everdict image push --registry
  host: z.string(),
  namespace: z.string().optional(),
  username: z.string().optional(),
  pullSecretName: z.string().optional(),
  pushSecretName: z.string().optional(),
  imagePrefix: z.string(),
})

// GET /workspace/image-registries → { registries }.
export const imageRegistriesResponseSchema = z.object({
  registries: z.array(imageRegistryConfigSchema),
})

// PUT /workspace/image-registries → { config, missingSecrets? } (warns of missing referenced secrets).
export const imageRegistrySetResponseSchema = z.object({
  config: imageRegistryConfigSchema,
  missingSecrets: z.array(z.string()).optional(),
})

// Drift guards — all three are identical-shape (config = every wire field; roster = registries; set = config +
// missingSecrets), so the guards are bidirectional: a renamed/added field on EITHER side fails the web typecheck.
type AssertAssignable<A extends B, B> = A
type WebImageRegistryConfig = z.infer<typeof imageRegistryConfigSchema>
type WebImageRegistriesResponse = z.infer<typeof imageRegistriesResponseSchema>
type WebImageRegistrySetResponse = z.infer<typeof imageRegistrySetResponseSchema>
type _configFwd = AssertAssignable<WebImageRegistryConfig, ImageRegistryView>
type _configBack = AssertAssignable<ImageRegistryView, WebImageRegistryConfig>
type _rosterFwd = AssertAssignable<WebImageRegistriesResponse, ImageRegistryRoster>
type _rosterBack = AssertAssignable<ImageRegistryRoster, WebImageRegistriesResponse>
type _setFwd = AssertAssignable<WebImageRegistrySetResponse, ImageRegistryUpsertResult>
type _setBack = AssertAssignable<ImageRegistryUpsertResult, WebImageRegistrySetResponse>

// Exported names alias the contract types (consumers untouched: same identifiers).
export type ImageRegistryConfig = ImageRegistryView
export type ImageRegistriesResponse = ImageRegistryRoster
export type ImageRegistrySetResponse = ImageRegistryUpsertResult

export type __imageRegistryDriftGuard = [
  _configFwd,
  _configBack,
  _rosterFwd,
  _rosterBack,
  _setFwd,
  _setBack,
]
