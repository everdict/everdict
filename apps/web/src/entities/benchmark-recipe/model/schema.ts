import { z } from 'zod'

// Client mirror of the control plane benchmark recipe (BenchmarkAdapterSpec). The web couples over HTTP only — no backend package dependency.
// A recipe = a reusable adapter that produces a dataset (source + mapping + grading templates). Not a dataset itself.

// GET /benchmark-recipes list item (lightweight — id/versions/owner only).
export const recipeListItemSchema = z.object({
  id: z.string(),
  owner: z.string(),
  versions: z.array(z.string()),
})
export type RecipeListItem = z.infer<typeof recipeListItemSchema>
export const recipeListSchema = z.array(recipeListItemSchema)

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
