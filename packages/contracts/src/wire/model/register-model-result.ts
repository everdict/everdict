import { z } from "zod";

// POST /models 201 — registered coordinates.
export const RegisterModelResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
});
export type RegisterModelResult = z.infer<typeof RegisterModelResultSchema>;
