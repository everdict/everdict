import { z } from 'zod'

// Client mirror of the control-plane JudgeSpec (Agent Judge). The web couples over HTTP only — no backend package dependency.
// GET /judges response: the judge list a tenant sees (owned + _shared defaults).
export const judgeSummarySchema = z.object({
  id: z.string(),
  owner: z.string(),
  versions: z.array(z.string()),
  // version → free-form labels (only versions that have tags) — mutable meta outside the spec.
  versionTags: z.record(z.string(), z.array(z.string())).optional(),
})
export type JudgeSummary = z.infer<typeof judgeSummarySchema>
export const judgesSchema = z.array(judgeSummarySchema)

// A judge's rubric: inline freeform text OR a reference to a registered rubric (id + version, "latest" allowed).
export const judgeRubricRefSchema = z.object({ id: z.string(), version: z.string() })
export type JudgeRubricRef = z.infer<typeof judgeRubricRefSchema>
export const judgeRubricSchema = z.union([z.string(), judgeRubricRefSchema])
export type JudgeRubric = z.infer<typeof judgeRubricSchema>

// Full JudgeSpec (model | harness) — loose mirror for display (the rest passthrough).
export const judgeSpecSchema = z
  .object({
    kind: z.enum(['model', 'harness']),
    id: z.string(),
    version: z.string(),
    description: z.string().optional(),
    // model kind
    provider: z.string().optional(),
    model: z.string().optional(),
    rubric: judgeRubricSchema.optional(), // model: required (server enforces) / harness: optional
    inputs: z.array(z.string()).optional(),
    passThreshold: z.number().optional(),
    // harness kind
    harness: z.object({ id: z.string(), version: z.string() }).optional(),
    runtime: z.string().optional(), // harness-judge execution runtime (absent = co-locate with the produced run)
    tags: z.array(z.string()).optional(),
  })
  .passthrough()
export type JudgeSpec = z.infer<typeof judgeSpecSchema>

// Narrowing helper — the two rubric shapes render differently (text block vs link chip).
export function isRubricRef(rubric: JudgeRubric): rubric is JudgeRubricRef {
  return typeof rubric !== 'string'
}
