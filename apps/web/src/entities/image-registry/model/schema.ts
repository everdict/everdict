import { z } from 'zod'

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
export type ImageRegistryConfig = z.infer<typeof imageRegistryConfigSchema>

// GET /workspace/image-registries → { registries }.
export const imageRegistriesResponseSchema = z.object({
  registries: z.array(imageRegistryConfigSchema),
})
export type ImageRegistriesResponse = z.infer<typeof imageRegistriesResponseSchema>

// PUT /workspace/image-registries → { config, missingSecrets? } (warns of missing referenced secrets).
export const imageRegistrySetResponseSchema = z.object({
  config: imageRegistryConfigSchema,
  missingSecrets: z.array(z.string()).optional(),
})
export type ImageRegistrySetResponse = z.infer<typeof imageRegistrySetResponseSchema>
