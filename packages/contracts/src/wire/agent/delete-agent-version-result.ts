import { z } from "zod";

// DELETE /agents/:id/versions/:version 200 — soft-delete (tombstone) acknowledgement.
export const DeleteAgentVersionResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
  deleted: z.literal(true),
});
export type DeleteAgentVersionResult = z.infer<typeof DeleteAgentVersionResultSchema>;
