import { z } from 'zod'

import type { AuthContext } from '@/shared/lib/control-plane'
import { controlPlane } from '@/shared/lib/control-plane'

// The product's imported service versions — the insert-once ledger the watch series uses as its x-axis. A
// product page that shows releases and not the versions underneath them cannot answer "what shipped between
// these two", which is the question a timeline exists for. Census slice 5.
// docs/architecture/web-runtime-gap-census-spec.md
export const productVersionsSchema = z.object({
  versions: z
    .array(
      z
        .object({
          service: z.string().optional(),
          version: z.string(),
          at: z.string().optional(),
          source: z.string().optional(),
        })
        .passthrough()
    )
    .default([]),
})
export type ProductVersions = z.infer<typeof productVersionsSchema>

// Best-effort: a product page whose version read failed still shows the product, and absent reads as
// "not read" rather than "no versions".
export async function loadProductVersions(ctx: AuthContext, id: string): Promise<ProductVersions | undefined> {
  try {
    return productVersionsSchema.parse(await controlPlane.listProductVersions(ctx, id))
  } catch {
    return undefined
  }
}
