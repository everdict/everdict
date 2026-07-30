import { z } from "zod";
import { AgentSessionRecordSchema } from "../../records/agent-session.js";

// Single-session response — the AgentSessionRecordSchema IS the SSOT (id/tenant/owner/title/createdAt/updatedAt),
// plus `live`: a COMPUTED view field (a chat turn is streaming in the agent process right now — the web re-attaches
// to it via GET /agent/sessions/:id/stream). Never persisted; the agent service decorates responses from its
// in-process live-turn registry, so the field exists on the wire only, not on the record.
export const AgentSessionResponseSchema = AgentSessionRecordSchema.extend({
  live: z.boolean().optional(),
});
export type AgentSessionResponse = z.infer<typeof AgentSessionResponseSchema>;
