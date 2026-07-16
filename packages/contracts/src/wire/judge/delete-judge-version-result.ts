import { z } from "zod";

// DELETE /judges/:id/versions/:version 200 — soft-delete (tombstone) acknowledgement.
export const DeleteJudgeVersionResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
  deleted: z.literal(true),
});
export type DeleteJudgeVersionResult = z.infer<typeof DeleteJudgeVersionResultSchema>;
