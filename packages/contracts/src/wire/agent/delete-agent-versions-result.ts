import { z } from "zod";

// DELETE /agents/:id 200 — bulk soft-delete (tombstone) acknowledgement. `deleted` lists the versions that were
// tombstoned (all of the agent's own live versions when the request omits `versions`, else exactly the ones asked for).
export const DeleteAgentVersionsResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  deleted: z.array(z.string()),
});
export type DeleteAgentVersionsResult = z.infer<typeof DeleteAgentVersionsResultSchema>;
