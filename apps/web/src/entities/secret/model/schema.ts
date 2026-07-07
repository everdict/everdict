import { z } from 'zod'

// Client mirror of the control-plane GET /secrets response — name + updated time + scope.
// scope: "workspace" (shared, admin-managed) | "user" (my personal, self-managed). Values are write-only (never returned after saving).
export const secretScopeSchema = z.enum(['user', 'workspace'])
export type SecretScope = z.infer<typeof secretScopeSchema>

export const secretMetaSchema = z.object({
  name: z.string(),
  updatedAt: z.string(),
  scope: secretScopeSchema.default('workspace'),
})
export type SecretMeta = z.infer<typeof secretMetaSchema>

export const secretsSchema = z.array(secretMetaSchema)
