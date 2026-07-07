import { z } from 'zod'

// Client mirror of the control plane dataset. The web couples over HTTP only — no backend package dependency.

// Source data provenance (lineage) — where the case rows came from. HF dataset/file/split + canonical link.
export const datasetSourceRefSchema = z.object({
  kind: z.enum(['huggingface', 'jsonl']),
  dataset: z.string().optional(),
  config: z.string().optional(),
  split: z.string().optional(),
  file: z.string().optional(),
  url: z.string().optional(),
})
export type DatasetSourceRef = z.infer<typeof datasetSourceRefSchema>

// Official provenance of the published benchmark (if any) — homepage/paper/code/data/leaderboard/authors/license/citation/task type.
export const datasetOriginSchema = z.object({
  homepage: z.string().optional(),
  paper: z.string().optional(),
  code: z.string().optional(),
  data: z.string().optional(),
  leaderboard: z.string().optional(),
  authors: z.string().optional(),
  license: z.string().optional(),
  citation: z.string().optional(),
  taskType: z.string().optional(),
})
export type DatasetOrigin = z.infer<typeof datasetOriginSchema>

// Dataset provenance — how it was made (recipe/catalog/spec) + source data provenance (lineage) + official provenance.
export const datasetProvenanceSchema = z.object({
  via: z.enum(['recipe', 'catalog', 'spec']),
  id: z.string(),
  version: z.string().optional(),
  source: datasetSourceRefSchema.optional(),
  origin: datasetOriginSchema.optional(),
})
export type DatasetProvenance = z.infer<typeof datasetProvenanceSchema>

// A single GET /datasets response item (DatasetListEntry mirror): summarizes one id (many immutable versions) into list-view meta.
// Content (caseCount/description/tags/producedBy) comes from the latest version, creator·timestamps from the registration history.
// Past/seed records may lack meta, so most fields are optional.
export const datasetSummarySchema = z.object({
  id: z.string(),
  owner: z.string(),
  versions: z.array(z.string()),
  latestVersion: z.string().optional(),
  caseCount: z.number().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  producedBy: datasetProvenanceSchema.optional(),
  createdBy: z.string().optional(), // creator subject of the first registered version (none for seed/_shared)
  createdAt: z.string().optional(), // timestamp of the first version registration (ISO)
  updatedAt: z.string().optional(), // timestamp of the most recent version registration (ISO)
  // version → free-form labels (only versions that have tags) — mutable meta outside the spec, distinct from content tags (entity classification), for telling versions apart.
  versionTags: z.record(z.string(), z.array(z.string())).optional(),
})
export type DatasetSummary = z.infer<typeof datasetSummarySchema>
export const datasetsSchema = z.array(datasetSummarySchema)

// eval case (loose mirror — only fields needed for UI display, the rest passthrough).
export const datasetCaseSchema = z
  .object({
    id: z.string(),
    task: z.string(),
    env: z.object({ kind: z.string() }).passthrough().optional(),
    graders: z.array(z.object({ id: z.string() }).passthrough()).default([]),
    tags: z.array(z.string()).default([]),
    timeoutSec: z.number().optional(), // case time budget (seconds) — shown if present
  })
  .passthrough()
export type DatasetCase = z.infer<typeof datasetCaseSchema>

// GET /datasets/:id/versions/:version response: the full dataset (including cases).
export const datasetSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  cases: z.array(datasetCaseSchema),
  tags: z.array(z.string()).default([]),
  producedBy: datasetProvenanceSchema.optional(), // ingestion provenance (if any). Unset for past datasets.
})
export type Dataset = z.infer<typeof datasetSchema>

// GET /datasets/:id/diff?base&candidate response: structural diff between versions (control plane DatasetDiff mirror).
const fieldChangeSchema = z.object({
  field: z.string(),
  before: z.string(),
  after: z.string(),
})
export type DatasetFieldChange = z.infer<typeof fieldChangeSchema>
const caseRefSchema = z.object({ id: z.string(), task: z.string() })
export const datasetDiffSchema = z.object({
  id: z.string(),
  base: z.string(),
  candidate: z.string(),
  meta: z.array(fieldChangeSchema),
  added: z.array(caseRefSchema),
  removed: z.array(caseRefSchema),
  changed: z.array(z.object({ id: z.string(), changes: z.array(fieldChangeSchema) })),
  unchanged: z.number(),
  summary: z.object({
    added: z.number(),
    removed: z.number(),
    changed: z.number(),
    unchanged: z.number(),
  }),
})
export type DatasetDiff = z.infer<typeof datasetDiffSchema>
