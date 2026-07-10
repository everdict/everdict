import { z } from "zod";

// DELETE /harnesses/:id/versions/:version 200 — soft-delete (tombstone) acknowledgement.
export const DeleteHarnessVersionResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
  deleted: z.literal(true),
});
export type DeleteHarnessVersionResult = z.infer<typeof DeleteHarnessVersionResultSchema>;
