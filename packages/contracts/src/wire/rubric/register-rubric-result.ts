import { z } from "zod";

// POST /rubrics 201 — registered coordinates.
export const RegisterRubricResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
});
export type RegisterRubricResult = z.infer<typeof RegisterRubricResultSchema>;
