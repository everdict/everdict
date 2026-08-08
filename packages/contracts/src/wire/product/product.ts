import { z } from "zod";
import {
  ProductRecordSchema,
  ProductServiceVersionRecordSchema,
  ReleaseReadinessSchema,
  ReleaseRecordSchema,
} from "../../records/product.js";

// The product timeline's wire surface (docs/architecture/product-timeline.md).

export const ProductListResponseSchema = z.array(ProductRecordSchema);
export type ProductListResponse = z.infer<typeof ProductListResponseSchema>;

// GET /products/:id — the record plus what its screen opens on: every release and the visible slice of the
// version ledger. The trend itself is the timeline read (windowed, heavier), not the detail's.
export const ProductDetailResponseSchema = ProductRecordSchema.extend({
  releases: z.array(ReleaseRecordSchema),
  versions: z.array(ProductServiceVersionRecordSchema),
});
export type ProductDetailResponse = z.infer<typeof ProductDetailResponseSchema>;

// GET /releases/:id — the record plus how ready it is (open linked issues + every watched series against its
// baseline). Derived on read, the tracker's rollup treatment.
export const ReleaseDetailResponseSchema = ReleaseRecordSchema.extend({
  readiness: ReleaseReadinessSchema,
});
export type ReleaseDetailResponse = z.infer<typeof ReleaseDetailResponseSchema>;

// POST /products/:id/sync — what the pull did, per service, and what it fanned out.
export const ProductSyncResponseSchema = z.object({
  services: z.array(
    z.object({
      name: z.string(),
      imported: z.number().int().nonnegative(),
      error: z.string().optional(),
    }),
  ),
  triggered: z.array(z.string()),
  failedSeries: z.array(z.object({ key: z.string(), error: z.string() })).optional(),
});
export type ProductSyncResponse = z.infer<typeof ProductSyncResponseSchema>;
