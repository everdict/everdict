import { z } from "zod";

// DELETE /models/:id/versions/:version 200 — soft-delete (tombstone) acknowledgement.
export const DeleteModelVersionResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
  deleted: z.literal(true),
});
export type DeleteModelVersionResult = z.infer<typeof DeleteModelVersionResultSchema>;
