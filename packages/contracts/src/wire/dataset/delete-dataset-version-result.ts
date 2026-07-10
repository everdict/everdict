import { z } from "zod";

// DELETE /datasets/:id/versions/:version 200 — soft-delete (tombstone) acknowledgement.
export const DeleteDatasetVersionResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
  deleted: z.literal(true),
});
