import type { JudgeListEntry, JudgeSpecDiffResponse } from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED list type is anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
// GET /judges response: the judge list a tenant sees (owned + _shared defaults).
export const judgeSummarySchema = z.object({
  id: z.string(),
  owner: z.string(),
  versions: z.array(z.string()),
  // version → free-form labels (only versions that have tags) — mutable meta outside the spec.
  versionTags: z.record(z.string(), z.array(z.string())).optional(),
})
export const judgesSchema = z.array(judgeSummarySchema)

// A judge's rubric: inline freeform text OR a reference to a registered rubric (id + version, "latest" allowed).
// These are inline sub-shapes of the JudgeSpec union — no standalone wire counterpart, so they stay LOCAL.
export const judgeRubricRefSchema = z.object({ id: z.string(), version: z.string() })
export type JudgeRubricRef = z.infer<typeof judgeRubricRefSchema>
export const judgeRubricSchema = z.union([z.string(), judgeRubricRefSchema])
export type JudgeRubric = z.infer<typeof judgeRubricSchema>

// Full JudgeSpec (model | harness) — DELIBERATELY LOOSE flat display mirror (the rest passthrough). Stays LOCAL,
// NOT anchored: the contract JudgeSpec is a DISCRIMINATED UNION (model requires model/rubric; harness requires
// harness) with per-kind required fields, whereas the web flattens every kind-specific field to optional so the
// detail view can read any field defensively. The two shapes genuinely diverge (flat-optional vs kind-narrowed
// union), so no assignability guard can bind them — the web only displays fields, never reconstructs a spec.
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

// GET /judges/:id/diff — a single leaf change (field path before → after) between two judge versions.
export const judgeFieldChangeSchema = z.object({
  path: z.string(),
  before: z.string(),
  after: z.string(),
  change: z.enum(['added', 'removed', 'changed']),
})
export type JudgeFieldChange = z.infer<typeof judgeFieldChangeSchema>

// The structural diff of two judge versions (base ↔ candidate). kindChanged flags a model↔harness restructure.
export const judgeSpecDiffSchema = z.object({
  id: z.string(),
  base: z.string(),
  candidate: z.string(),
  kindChanged: z.boolean(),
  changes: z.array(judgeFieldChangeSchema),
  summary: z.object({
    added: z.number(),
    removed: z.number(),
    changed: z.number(),
  }),
})
export type JudgeSpecDiff = z.infer<typeof judgeSpecDiffSchema>

// Drift guard — JudgeSummary is a NARROWER view of the wire list entry: the web models only id/owner/versions/
// versionTags and deliberately omits the entry's other fields (including its REQUIRED latestVersion/versionCount),
// so it can't guard forward (web ⊄ wire). Instead the Pick-reverse guard requires every field the web DOES model
// to exist on the wire with an assignable type — catching a rename/retype of one of those fields.
type AssertAssignable<A extends B, B> = A
type WebJudgeSummary = z.infer<typeof judgeSummarySchema>
type _summaryFieldsOnWire = AssertAssignable<
  Pick<JudgeListEntry, keyof WebJudgeSummary>,
  WebJudgeSummary
>

// JudgeSpecDiff is identical-shape to the wire diff DTO — guarded bidirectionally (a wire rename/retype fails the web typecheck).
type WebJudgeSpecDiff = z.infer<typeof judgeSpecDiffSchema>
type _diffFwd = AssertAssignable<WebJudgeSpecDiff, JudgeSpecDiffResponse>
type _diffBack = AssertAssignable<JudgeSpecDiffResponse, WebJudgeSpecDiff>

// Exported name keeps the web's narrower shape (anchored by the guard above).
export type JudgeSummary = WebJudgeSummary

export type __judgeDriftGuard = [_summaryFieldsOnWire, _diffFwd, _diffBack]
