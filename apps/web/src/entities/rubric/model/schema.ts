import { z } from 'zod'

// Client mirror of the control-plane RubricSpec (versioned judging criteria). The web couples over HTTP only — no backend package dependency.
// GET /rubrics response: the rubric list a tenant sees (owned + _shared).
export const rubricSummarySchema = z.object({
  id: z.string(),
  owner: z.string(),
  versions: z.array(z.string()),
  // version → free-form labels (only versions that have tags) — mutable meta outside the spec (for telling versions apart).
  versionTags: z.record(z.string(), z.array(z.string())).optional(),
})
export type RubricSummary = z.infer<typeof rubricSummarySchema>
export const rubricsSchema = z.array(rubricSummarySchema)

// One rubric criterion — scored separately by a multi-criteria judge; each lands as its own metric (judge:<judge-id>:<criterion-id>).
export const rubricCriterionSchema = z.object({
  id: z.string(),
  description: z.string(),
  weight: z.number().default(1), // server-side boundary default — the weighted overall uses 1 when unset
  passThreshold: z.number().optional(),
})
export type RubricCriterion = z.infer<typeof rubricCriterionSchema>

// Full RubricSpec — loose mirror for display (the rest passthrough). At least one of text/criteria/promptTemplate
// is present (the control plane enforces); promptTemplate always carries {verdict_instruction}.
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
