import { z } from "zod";

// POST /benchmark-recipes 201 — registered recipe coordinates.
export const RegisterBenchmarkRecipeResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
});
export type RegisterBenchmarkRecipeResult = z.infer<typeof RegisterBenchmarkRecipeResultSchema>;
