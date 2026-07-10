import { z } from "zod";

// POST /judges 201 — registered coordinates.
export const RegisterJudgeResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
});
export type RegisterJudgeResult = z.infer<typeof RegisterJudgeResultSchema>;
