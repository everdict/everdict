import { z } from "zod";
import { TrackerHistoryEntrySchema } from "./tracker.js";

// The PRODUCT TIMELINE — Product ⊃ Release, over a ledger of imported service versions
// (docs/architecture/product-timeline.md). The tracker answers "why we evaluate"; a Product answers "what we
// ship": the real services that compose the released thing, imported from GitHub releases/tags, and the trend
// series (dataset × harness × judges) whose scorecards tell whether the product got better between releases.
// A Release is the checkpoint on that axis — planned first, then released through a gate that refuses while
// linked issues are open or a watched series has regressed. Deliberately separate from Initiative: an
// initiative is a GOAL, a release is a DATE a specific composition of services went out on.

// Calendar dates, not instants — same rule as the tracker: "did we release by the 14th" is a date question,
// and the literal YYYY-MM-DD round-trips with no timezone reinterpretation.
const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected a YYYY-MM-DD date.");

// --- Tracked services: the product's real composition ---
// A service here is NOT the harness's topology service (that is an execution spec): it is the repository whose
// releases/tags mark "this component moved" on the product's time axis. GitHub is the source of record and
// everdict stays the client — versions arrive by pull (a member presses Sync, later a sweep), never by webhook,
// the same stance the GitHub issue sync takes.
export const PRODUCT_SERVICE_SOURCES = ["releases", "tags"] as const;
export const ProductServiceSourceSchema = z.enum(PRODUCT_SERVICE_SOURCES);
export type ProductServiceSource = z.infer<typeof ProductServiceSourceSchema>;

// Sync state per service — a REMOTE clock reading (the newest publishedAt successfully imported), so clock skew
// between the control plane and GitHub can never make us skip a version. Absent = never synced, and the first
// sync is a BACKFILL: it fills the timeline's past but never fires the auto-eval (a storm of runs for old
// versions is exactly what the watermark exists to prevent).
export const ProductServiceSyncSchema = z.object({
  syncedAt: z.string().optional(),
  lastError: z
    .object({
      at: z.string(),
      message: z.string(),
    })
    .optional(),
});
export type ProductServiceSync = z.infer<typeof ProductServiceSyncSchema>;

export const ProductServiceSchema = z.object({
  // Unique within the product (the service refuses duplicates) — this is the name the timeline and the version
  // ledger key on, so renaming it orphans the service's imported history on purpose (it is a new track).
  name: z.string().min(1).max(100),
  // Unset = github.com; set = the deployment's GitHub Enterprise host (same convention as WorkspaceCiLink).
  host: z.string().optional(),
  repository: z.string().min(1), // "owner/name"
  source: ProductServiceSourceSchema,
  // Only tags starting with this prefix belong to the service — a monorepo releases several services from one
  // repository ("api-v1.2.0" vs "web-v3.1.0"), and without the filter every service would claim every tag.
  tagPrefix: z.string().max(100).optional(),
  sync: ProductServiceSyncSchema.optional(),
});
export type ProductService = z.infer<typeof ProductServiceSchema>;

// --- Watch series: the trends the product is judged by ---
// One series = one question asked repeatedly ("agent quality on the support dataset, judged by helpfulness").
// The KEY is the series' durable identity: scorecards stamp it in their origin, so the trend survives renaming
// the label, and deleting a series stops future runs without unkeying the history already recorded.
const SeriesCapabilityRefSchema = z.object({
  id: z.string().min(1),
  // Absent = "latest at run time" — which is what a standing series means: the harness keeps evolving (CI
  // re-pins mint new instance versions) and the series evaluates whatever is current. Pinning is the exception.
  version: z.string().optional(),
});

export const ProductSeriesSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Series keys are lowercase slugs (a-z, 0-9, -)."),
  label: z.string().min(1).max(200),
  dataset: SeriesCapabilityRefSchema,
  harness: SeriesCapabilityRefSchema,
  judges: z.array(SeriesCapabilityRefSchema).default([]),
});
export type ProductSeries = z.infer<typeof ProductSeriesSchema>;

// How many series a product may declare — enough for "the axes we actually watch", small enough that a version
// import cannot fan out into an unbounded batch storm.
export const PRODUCT_SERIES_LIMIT = 20;

// Auto-eval: a newly imported service version submits one scorecard per watched series (the active planned
// release's selection, else every series). Enabled by default because it is the product timeline's point;
// the backfill rule above keeps the default safe.
export const ProductAutoEvalSchema = z.object({
  enabled: z.boolean(),
  // Placement override for the submitted batches (a RuntimeSpec name). Absent = the submitter's default.
  runtime: z.string().optional(),
});
export type ProductAutoEval = z.infer<typeof ProductAutoEvalSchema>;

export const ProductRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  // One emoji — same affordance (and same reasoning) as an initiative's icon.
  icon: z.string().max(8).optional(),
  services: z.array(ProductServiceSchema).default([]),
  series: z.array(ProductSeriesSchema).default([]),
  autoEval: ProductAutoEvalSchema.default({ enabled: true }),
  history: z.array(TrackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProductRecord = z.infer<typeof ProductRecordSchema>;

// --- Release: a checkpoint on the product's axis ---
// `planned` is where a release starts — a date and a scope somebody committed to. Moving to `released` is a
// GATE (the domain refuses while linked issues are open or a watched series regressed; `force` is recorded),
// because "we shipped" with open regressions should be a deliberate override, never a default.
export const RELEASE_STATUSES = ["planned", "released", "cancelled"] as const;
export const ReleaseStatusSchema = z.enum(RELEASE_STATUSES);
export type ReleaseStatus = z.infer<typeof ReleaseStatusSchema>;

export const ReleaseRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  productId: z.string(),
  name: z.string().min(1).max(200), // "2026.3", "v1.4.0" — the product's own naming, not a tag
  description: z.string().optional(),
  status: ReleaseStatusSchema,
  targetDate: CalendarDateSchema.optional(),
  releasedAt: z.string().optional(),
  // Which of the product's series this release watches. Absent = every series — the common case; a subset is
  // "this release is judged on these axes", and the gate + the readiness read honor exactly that selection.
  seriesKeys: z.array(z.string()).optional(),
  history: z.array(TrackerHistoryEntrySchema).default([]),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ReleaseRecord = z.infer<typeof ReleaseRecordSchema>;

// --- The imported version ledger (append-only) ---
// One row per (service, version) — the fact that a component moved, stamped with the remote's own publishedAt.
// Idempotent by that natural key: a re-sync can never duplicate a version, and therefore can never re-fire the
// auto-eval for one. Facts only: `prerelease` is GitHub's own flag, `notes` is the release body's first lines.
export const PRODUCT_VERSION_KINDS = ["release", "tag"] as const;
export const ProductVersionKindSchema = z.enum(PRODUCT_VERSION_KINDS);
export type ProductVersionKind = z.infer<typeof ProductVersionKindSchema>;

export const PRODUCT_VERSION_NOTES_LIMIT = 2000;

export const ProductServiceVersionRecordSchema = z.object({
  id: z.string(),
  tenant: z.string(),
  productId: z.string(),
  service: z.string(), // ProductService.name
  version: z.string().min(1), // the tag name, verbatim (no prefix stripping — the record keeps the fact)
  kind: ProductVersionKindSchema,
  prerelease: z.boolean().default(false),
  sha: z.string().optional(),
  url: z.string().optional(),
  notes: z.string().max(PRODUCT_VERSION_NOTES_LIMIT).optional(),
  publishedAt: z.string(), // the REMOTE clock — ordering on the timeline uses this, not our import time
  importedAt: z.string(),
});
export type ProductServiceVersionRecord = z.infer<typeof ProductServiceVersionRecordSchema>;

// --- Derived readiness (computed on detail reads, never stored) ---
// Same treatment as the tracker's rollups: the gate's two counts are cheap, always-fresh arithmetic over what
// the caller already fetched — a stored flag would be a cache to invalidate on every scorecard completion.
export const ReleaseSeriesStateSchema = z.object({
  key: z.string(),
  label: z.string(),
  // The newest succeeded scorecard stamped with this series, and the one anchoring the comparison — absent when
  // the series has not run yet (which is a real state the readiness card must show, not an error).
  latest: z
    .object({
      scorecardId: z.string(),
      passRate: z.number().optional(),
      createdAt: z.string(),
      serviceVersion: z.string().optional(),
    })
    .optional(),
  baseline: z
    .object({
      scorecardId: z.string(),
      passRate: z.number().optional(),
      createdAt: z.string(),
    })
    .optional(),
  // Arithmetic, never inference: latest.passRate < baseline.passRate, both measured. Anything unmeasured
  // (missing baseline, missing rate) reads as NOT regressed — absence of evidence is not a regression.
  regressed: z.boolean(),
});
export type ReleaseSeriesState = z.infer<typeof ReleaseSeriesStateSchema>;

export const ReleaseReadinessSchema = z.object({
  openIssues: z.number().int().nonnegative(),
  series: z.array(ReleaseSeriesStateSchema),
  regressedSeries: z.array(z.string()), // the keys, so the gate's refusal can name them
  ready: z.boolean(), // openIssues === 0 && regressedSeries.length === 0
});
export type ReleaseReadiness = z.infer<typeof ReleaseReadinessSchema>;
