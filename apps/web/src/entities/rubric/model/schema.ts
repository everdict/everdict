import type { RubricListEntry } from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED list type is anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
// GET /rubrics response: the rubric list a tenant sees (owned + _shared).
export const rubricSummarySchema = z.object({
  id: z.string(),
  owner: z.string(),
  versions: z.array(z.string()),
  // version → free-form labels (only versions that have tags) — mutable meta outside the spec (for telling versions apart).
  versionTags: z.record(z.string(), z.array(z.string())).optional(),
})
export const rubricsSchema = z.array(rubricSummarySchema)

// One rubric criterion — scored separately by a multi-criteria judge; each lands as its own metric (judge:<judge-id>:<criterion-id>).
// Sub-shape of the loose RubricSpec display view below — stays LOCAL with it.
export const rubricCriterionSchema = z.object({
  id: z.string(),
  description: z.string(),
  weight: z.number().default(1), // server-side boundary default — the weighted overall uses 1 when unset
  passThreshold: z.number().optional(),
})
export type RubricCriterion = z.infer<typeof rubricCriterionSchema>

// Full RubricSpec — DELIBERATELY LOOSE display mirror (the rest passthrough). Stays LOCAL, NOT anchored: the
// contract RubricSpec requires `tags: string[]` (default) whereas the web keeps `tags?` optional, and the web is
// `.passthrough()` (adds an index signature) — so the web view is not assignable to the contract spec. The web
// only displays fields defensively, so the loose local type is correct.
export const rubricSpecSchema = z
  .object({
    id: z.string(),
    version: z.string(),
    description: z.string().optional(),
    text: z.string().optional(),
    criteria: z.array(rubricCriterionSchema).optional(),
    promptTemplate: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .passthrough()
export type RubricSpec = z.infer<typeof rubricSpecSchema>

// Drift guard — RubricSummary is a NARROWER view of the wire list entry (the web omits the entry's other fields,
// including its REQUIRED latestVersion/versionCount), so it can't guard forward. The Pick-reverse guard requires
// every field the web DOES model to exist on the wire with an assignable type — catching a rename/retype.
type AssertAssignable<A extends B, B> = A
type WebRubricSummary = z.infer<typeof rubricSummarySchema>
type _summaryFieldsOnWire = AssertAssignable<
  Pick<RubricListEntry, keyof WebRubricSummary>,
  WebRubricSummary
>

// Exported name keeps the web's narrower shape (anchored by the guard above).
export type RubricSummary = WebRubricSummary

export type __rubricDriftGuard = [_summaryFieldsOnWire]
