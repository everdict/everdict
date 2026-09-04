import { z } from 'zod'

import type { AuthContext } from '@/shared/lib/control-plane'
import { controlPlane } from '@/shared/lib/control-plane'

// The environment REGISTRY — the world a case acts on, as a versioned entity. Distinct from the adopted
// IMAGES beside it: an image is bytes, an environment is the world those bytes make, and only the second
// one is an identity axis a batch can seal. Census slice 5.
// docs/architecture/web-runtime-gap-census-spec.md
export const environmentListSchema = z.object({
  environments: z
    .array(
      z
        .object({
          id: z.string(),
          owner: z.string().optional(),
          versions: z.array(z.string()).default([]),
          versionTags: z.record(z.string(), z.array(z.string())).optional(),
        })
        .passthrough()
    )
    .default([]),
})
export type EnvironmentList = z.infer<typeof environmentListSchema>

// A read that failed is carried as a value: the page shows the adopted images either way, and an empty
// registry and an unreadable one are different things a member has to be able to tell apart.
export async function loadEnvironments(
  ctx: AuthContext
): Promise<{ list?: EnvironmentList; error?: string }> {
  try {
    return { list: environmentListSchema.parse(await controlPlane.listEnvironments(ctx)) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
