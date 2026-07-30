import { z } from "zod";
import { AgentSessionResponseSchema } from "./agent-session.js";

// GET /agent/sessions response — the owner's sessions, newest first (updatedAt descending). Rows carry the same
// computed `live` decoration as the single-session response (the history menu's "running" badge).
export const AgentSessionListResponseSchema = z.object({
  sessions: z.array(AgentSessionResponseSchema).describe("Newest first (updatedAt descending)"),
});
export type AgentSessionListResponse = z.infer<typeof AgentSessionListResponseSchema>;
