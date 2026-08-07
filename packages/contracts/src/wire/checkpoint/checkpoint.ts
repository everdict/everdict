import type { z } from "zod";
import { HandoffCheckpointRecordSchema } from "../../records/ownership.js";

// Single handoff-checkpoint response — the ownership kernel's HandoffCheckpointRecordSchema IS the SSOT
// (the O6 contract plus the tenant it belongs to). Append-only: there is no update shape to mirror.
export const CheckpointResponseSchema = HandoffCheckpointRecordSchema;
export type CheckpointResponse = z.infer<typeof CheckpointResponseSchema>;
