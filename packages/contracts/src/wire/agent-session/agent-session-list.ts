import { z } from "zod";
import { AgentSessionRecordSchema } from "../../records/agent-session.js";

// GET /agent/sessions response — the owner's sessions, newest first (updatedAt descending).
export const AgentSessionListResponseSchema = z.object({
  sessions: z.array(AgentSessionRecordSchema).describe("Newest first (updatedAt descending)"),
});
export type AgentSessionListResponse = z.infer<typeof AgentSessionListResponseSchema>;
