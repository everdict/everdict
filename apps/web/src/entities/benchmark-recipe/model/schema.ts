import type { BenchmarkRecipeListEntry } from '@everdict/contracts/wire'
import { z } from 'zod'

// Runtime boundary validation stays here (zod v4); the EXPORTED list type is anchored to @everdict/contracts
// (re-architecture P4). `import type` only — the zod v3 wire schemas never run in the web.
// Client mirror of the control plane benchmark recipe (BenchmarkAdapterSpec, in @everdict/datasets — a
// control-plane package with NO wire DTO for the full spec). A recipe = a reusable adapter that produces a
// dataset (source + mapping + grading templates). Only the list item has a wire counterpart; the full RecipeSpec
// and its sub-shapes (source/origin/mapping/graderTemplates) have NO contract type, so they stay LOCAL.

// GET /benchmark-recipes list item (lightweight — id/versions/owner only).
export const recipeListItemSchema = z.object({
  id: z.string(),
  owner: z.string(),
  versions: z.array(z.string()),
})
export const recipeListSchema = z.array(recipeListItemSchema)

// Drift guard — RecipeListItem is identical-shape to the wire list entry (id/owner/versions), so the guard is
// bidirectional: a renamed/added field on EITHER side fails the web typecheck.
type AssertAssignable<A extends B, B> = A
type WebRecipeListItem = z.infer<typeof recipeListItemSchema>
type _listItemFwd = AssertAssignable<WebRecipeListItem, BenchmarkRecipeListEntry>
type _listItemBack = AssertAssignable<BenchmarkRecipeListEntry, WebRecipeListItem>
export type RecipeListItem = BenchmarkRecipeListEntry
export type __recipeListDriftGuard = [_listItemFwd, _listItemBack]

// source — huggingface (dataset/config/split/gated) or jsonl. passthrough for future extension.
export const recipeSourceSchema = z
  .object({
    kind: z.string(),
    dataset: z.string().optional(),
    config: z.string().optional(),
    split: z.string().optional(),
    gated: z.boolean().optional(),
  })
  .passthrough()
export type RecipeSource = z.infer<typeof recipeSourceSchema>

// mapping — which source field becomes the case's id/task/answer/…. Many fields that keep growing, so a loose record.
export const recipeMappingSchema = z.record(z.string(), z.unknown())

// grader templates — per-case grader built via per-row {field} interpolation.
export const recipeGraderTemplateSchema = z
  .object({ id: z.string(), config: z.record(z.string(), z.unknown()).optional() })
  .passthrough()

// origin — the source benchmark's provenance (homepage/paper/code/data/official leaderboard, etc.). Display-only metadata.
export const recipeOriginSchema = z
  .object({
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
  .partial()
export type RecipeOrigin = z.infer<typeof recipeOriginSchema>

// GET /benchmark-recipes/:id/versions/:version — full spec (for detail view).
export const recipeSpecSchema = z
  .object({
    id: z.string(),
    version: z.string(),
    description: z.string().optional(),
    category: z.string().default('qa'),
    origin: recipeOriginSchema.optional(),
    source: recipeSourceSchema,
    mapping: recipeMappingSchema.default({}),
    graderTemplates: z.array(recipeGraderTemplateSchema).optional(),
  })
  .passthrough()
export type RecipeSpec = z.infer<typeof recipeSpecSchema>
