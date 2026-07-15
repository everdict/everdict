import { z } from "zod";

// DELETE /datasets/:id body (optional) — bulk soft-delete. `versions` selects specific versions to tombstone; omit the
// body entirely (or leave `versions` unset) to delete the whole dataset (all of its own live versions). An empty array
// is rejected (400) rather than silently meaning "all" — the caller must be explicit.
export const DeleteDatasetVersionsBodySchema = z.object({
  versions: z.array(z.string().min(1)).min(1).optional(),
});
