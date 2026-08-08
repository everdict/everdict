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

// GET /products/:id/timeline — the product's time axis in one read: releases (past + planned), the windowed
// version ledger, each watch series' scorecard points, and the lifecycle markers of linked issues. Composed
// from stores on the server (the pulse's treatment) so the web draws, never derives.
export const ProductSeriesPointSchema = z.object({
  scorecardId: z.string(),
  status: z.string(),
  passRate: z.number().optional(),
  createdAt: z.string(),
  serviceVersion: z.string().optional(),
  releaseId: z.string().optional(),
});
export type ProductSeriesPoint = z.infer<typeof ProductSeriesPointSchema>;

export const ProductTimelineSeriesSchema = z.object({
  key: z.string(),
  label: z.string(),
  points: z.array(ProductSeriesPointSchema), // oldest first — the drawing order
});
export type ProductTimelineSeries = z.infer<typeof ProductTimelineSeriesSchema>;

// One linked issue's lifecycle on the axis: when it arrived, whether (and when) it was resolved, and where it
// stands now — enough to draw a marker and link out, never the whole record.
export const ProductTimelineIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  status: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().optional(),
  // Which release the issue is linked to, when it is release-linked rather than product-linked.
  releaseId: z.string().optional(),
});
export type ProductTimelineIssue = z.infer<typeof ProductTimelineIssueSchema>;

export const ProductTimelineResponseSchema = z.object({
  window: z.object({ from: z.string(), to: z.string() }),
  releases: z.array(ReleaseRecordSchema),
  versions: z.array(ProductServiceVersionRecordSchema),
  series: z.array(ProductTimelineSeriesSchema),
  issues: z.array(ProductTimelineIssueSchema),
});
export type ProductTimelineResponse = z.infer<typeof ProductTimelineResponseSchema>;

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
