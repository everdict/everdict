import { z } from "zod";

// DELETE /models/:id 200 — bulk soft-delete (tombstone) acknowledgement. `deleted` lists the versions that were
// tombstoned (all of the model's own live versions when the request omits `versions`, else exactly the ones asked for).
export const DeleteModelVersionsResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  deleted: z.array(z.string()),
});
export type DeleteModelVersionsResult = z.infer<typeof DeleteModelVersionsResultSchema>;
