import { z } from "zod";

// POST /benchmark-recipes/validate 200 — dry-run outcome. Schema failures come back as ok:false (not 400).
export const ValidateBenchmarkRecipeResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    id: z.string(),
    version: z.string(),
    source: z.string().describe("Source kind (huggingface | jsonl)"),
    graderTemplates: z.number().int().describe("Number of per-row grader templates in the recipe"),
    existingVersions: z.array(z.string()).describe("Versions this workspace registered directly (no _shared fallback)"),
    versionExists: z.boolean().describe("True when the submitted version collides with an existing one"),
  }),
  z.object({
    ok: z.literal(false),
    errors: z.array(z.string()).describe("Schema issues (path: message)"),
    existingVersions: z.array(z.string()),
    versionExists: z.boolean(),
  }),
]);
export type ValidateBenchmarkRecipeResult = z.infer<typeof ValidateBenchmarkRecipeResultSchema>;
