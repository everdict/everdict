import type {
  Dataset as WireDataset,
  DatasetDiff as WireDatasetDiff,
  DatasetFieldChange as WireDatasetFieldChange,
  DatasetOrigin as WireDatasetOrigin,
  DatasetProvenance as WireDatasetProvenance,
  DatasetSourceRef as WireDatasetSourceRef,
} from '@everdict/contracts'
import type { DatasetListEntry } from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED types are anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.

// Source data provenance (lineage) — where the case rows came from. HF dataset/file/split + canonical link.
export const datasetSourceRefSchema = z.object({
  kind: z.enum(['huggingface', 'jsonl']),
  dataset: z.string().optional(),
  config: z.string().optional(),
  split: z.string().optional(),
  file: z.string().optional(),
  url: z.string().optional(),
})

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

// Dataset provenance — how it was made (recipe/catalog/spec) + source data provenance (lineage) + official provenance.
export const datasetProvenanceSchema = z.object({
  via: z.enum(['recipe', 'catalog', 'spec']),
  id: z.string(),
  version: z.string().optional(),
  source: datasetSourceRefSchema.optional(),
  origin: datasetOriginSchema.optional(),
})

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
export const datasetsSchema = z.array(datasetSummarySchema)

// eval case (loose mirror — only fields needed for UI display, the rest passthrough). Stays LOCAL: the contract
// EvalCase has a structured env/graders (EnvSpec/GraderSpec[]) the web flattens to loose passthrough shapes.
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

// GET /datasets/:id/diff?base&candidate response: structural diff between versions (control plane DatasetDiff mirror).
const fieldChangeSchema = z.object({
  field: z.string(),
  before: z.string(),
  after: z.string(),
})
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

// Drift guards.
// SourceRef/Origin/Provenance/FieldChange/DatasetDiff are identical-shape — bidirectional (int()-branded wire
// numbers still infer `number`, matching the web's plain numbers).
// DatasetSummary is a NARROWER view of the wire list entry (the web keeps latestVersion/caseCount/tags OPTIONAL
// where the wire requires them), so it uses the Pick-reverse guard: every field the web models must exist on the
// wire with an assignable type.
// Dataset is the run-style split: its FLAT fields anchor to the contract Dataset, but `cases` is a DELIBERATELY
// LOOSE local view (DatasetCase, above), so it is excluded from the flat guard.
type AssertAssignable<A extends B, B> = A
type WebDatasetSourceRef = z.infer<typeof datasetSourceRefSchema>
type WebDatasetOrigin = z.infer<typeof datasetOriginSchema>
type WebDatasetProvenance = z.infer<typeof datasetProvenanceSchema>
type WebDatasetSummary = z.infer<typeof datasetSummarySchema>
type WebDatasetFieldChange = z.infer<typeof fieldChangeSchema>
type WebDatasetDiff = z.infer<typeof datasetDiffSchema>
type WebDatasetFlat = Omit<z.infer<typeof datasetSchema>, 'cases'>
type WireDatasetFlat = Omit<WireDataset, 'cases'>

type _sourceFwd = AssertAssignable<WebDatasetSourceRef, WireDatasetSourceRef>
type _sourceBack = AssertAssignable<WireDatasetSourceRef, WebDatasetSourceRef>
type _originFwd = AssertAssignable<WebDatasetOrigin, WireDatasetOrigin>
type _originBack = AssertAssignable<WireDatasetOrigin, WebDatasetOrigin>
type _provenanceFwd = AssertAssignable<WebDatasetProvenance, WireDatasetProvenance>
type _provenanceBack = AssertAssignable<WireDatasetProvenance, WebDatasetProvenance>
type _summaryFieldsOnWire = AssertAssignable<
  Pick<DatasetListEntry, keyof WebDatasetSummary>,
  WebDatasetSummary
>
type _fieldChangeFwd = AssertAssignable<WebDatasetFieldChange, WireDatasetFieldChange>
type _fieldChangeBack = AssertAssignable<WireDatasetFieldChange, WebDatasetFieldChange>
type _diffFwd = AssertAssignable<WebDatasetDiff, WireDatasetDiff>
type _diffBack = AssertAssignable<WireDatasetDiff, WebDatasetDiff>
type _datasetFlatFwd = AssertAssignable<WebDatasetFlat, WireDatasetFlat>
type _datasetFlatFieldsOnWire = AssertAssignable<
  Pick<WireDatasetFlat, keyof WebDatasetFlat>,
  WebDatasetFlat
>

// Exported names alias the contract types where identical; DatasetSummary keeps its narrower web shape, and
// Dataset = the contract's FLAT fields + the web's loose `cases` view (both anchored by the guards above).
export type DatasetSourceRef = WireDatasetSourceRef
export type DatasetOrigin = WireDatasetOrigin
export type DatasetProvenance = WireDatasetProvenance
export type DatasetSummary = WebDatasetSummary
export type DatasetFieldChange = WireDatasetFieldChange
export type DatasetDiff = WireDatasetDiff
export type Dataset = WireDatasetFlat & { cases: DatasetCase[] }

export type __datasetDriftGuard = [
  _sourceFwd,
  _sourceBack,
  _originFwd,
  _originBack,
  _provenanceFwd,
  _provenanceBack,
  _summaryFieldsOnWire,
  _fieldChangeFwd,
  _fieldChangeBack,
  _diffFwd,
  _diffBack,
  _datasetFlatFwd,
  _datasetFlatFieldsOnWire,
]
