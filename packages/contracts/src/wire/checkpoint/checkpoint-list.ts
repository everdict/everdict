import { z } from "zod";
import { HandoffCheckpointRecordSchema } from "../../records/ownership.js";

// GET /checkpoints response — the workspace's handoffs, newest first.
export const CheckpointListResponseSchema = z.array(HandoffCheckpointRecordSchema);
export type CheckpointListResponse = z.infer<typeof CheckpointListResponseSchema>;
