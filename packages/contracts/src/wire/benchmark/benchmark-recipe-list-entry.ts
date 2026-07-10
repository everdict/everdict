import { z } from "zod";

// GET /benchmark-recipes 200 — one entry per recipe id (workspace-owned + _shared fallback).
export const BenchmarkRecipeListEntrySchema = z.object({
  id: z.string(),
  versions: z.array(z.string()).describe("Versions (semver ascending)"),
  owner: z.string().describe("Owning tenant, or _shared for first-party recipes"),
});
export type BenchmarkRecipeListEntry = z.infer<typeof BenchmarkRecipeListEntrySchema>;

export const BenchmarkRecipeListResponseSchema = z.array(BenchmarkRecipeListEntrySchema);
export type BenchmarkRecipeListResponse = z.infer<typeof BenchmarkRecipeListResponseSchema>;
