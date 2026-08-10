import { z } from "zod";
import {
  ProductRecordSchema,
  ProductServiceSourceSchema,
  ProductServiceVersionRecordSchema,
  ProductVersionKindSchema,
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

// POST /products/discover — ONE read of a repository, so declaring a product's composition is a CHOICE
// instead of a form. Everything a service row needs (its name, its subpath, which tags are its stream, when
// that stream last moved) is derivable from what the repository already says, and typing it by hand is how a
// tagPrefix ends up matching nothing and a service silently imports zero versions forever.
//
// Read-only and PERSISTS NOTHING: it is the wizard's evidence, not a registration. The same read backs the
// edit form's preview, which is why it returns the version NAMES rather than a per-prefix count — the client
// re-filters as the user tweaks a prefix, so a preview never costs another round trip to GitHub.
export const RepoVersionSampleSchema = z.object({
  name: z.string(), // the tag name verbatim — prefix matching is the caller's, on the same bytes the sync uses
  kind: ProductVersionKindSchema,
  prerelease: z.boolean(),
  // The remote's own instant. Releases always carry one; TAGS do not, so the reader resolves commit dates for
  // the newest few only (a bounded, declared cost) and the rest arrive dateless — absent means "not resolved
  // here", never "no date".
  publishedAt: z.string().optional(),
  url: z.string().optional(),
});
export type RepoVersionSample = z.infer<typeof RepoVersionSampleSchema>;

// One deployable unit found in the repository tree — the monorepo half of the answer.
export const RepoPackageSchema = z.object({
  path: z.string(), // "apps/api" — the repo-relative directory, which becomes ProductService.path
  name: z.string(), // the manifest's own name, else the directory tail
  manifest: z.string(), // "package.json" | "go.mod" | "pyproject.toml" | "Cargo.toml" | "Dockerfile"
});
export type RepoPackage = z.infer<typeof RepoPackageSchema>;

// A PROPOSED service row — the thing the wizard renders as a checkbox. `recommended` is the difference
// between "this repository demonstrably releases this" (a tag stream exists) and "this directory looks
// deployable" (a package with no stream of its own, which under a repo-wide tag stream is a real service and
// under nothing at all is a guess); only the first is pre-checked.
export const ProductServiceSuggestionSchema = z.object({
  name: z.string(),
  path: z.string().optional(),
  source: ProductServiceSourceSchema,
  tagPrefix: z.string().optional(),
  recommended: z.boolean(),
  matched: z.number().int().nonnegative(), // versions in the sample this stream claims
  latestVersion: z.string().optional(),
  latestPublishedAt: z.string().optional(),
  firstPublishedAt: z.string().optional(),
});
export type ProductServiceSuggestion = z.infer<typeof ProductServiceSuggestionSchema>;

export const ProductRepoDiscoveryResponseSchema = z.object({
  repository: z.string(),
  host: z.string().optional(),
  // WHICH stream the samples came from. Releases are read first because a published release is the stronger
  // claim; a repository that publishes none falls back to tags, and the wizard's rows inherit that choice.
  source: ProductServiceSourceSchema,
  versions: z.array(RepoVersionSampleSchema),
  packages: z.array(RepoPackageSchema),
  suggestions: z.array(ProductServiceSuggestionSchema),
  // Whether the reads saw the whole history / the whole tree. A bound that is reported rather than one that
  // merely happens — a truncated sample makes a prefix's count a floor, and the wizard says so.
  complete: z.boolean(),
});
export type ProductRepoDiscoveryResponse = z.infer<typeof ProductRepoDiscoveryResponseSchema>;

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
