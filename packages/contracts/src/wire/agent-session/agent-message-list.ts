import { z } from "zod";
import { AgentMessageRecordSchema } from "../../records/agent-session.js";

// GET /agent/sessions/:id/messages response — the session transcript, oldest first (seq ascending). Supports an
// incremental `?since=<seq>` fetch for polling, in which case only messages with a greater seq are returned.
export const AgentMessageListResponseSchema = z.object({
  messages: z.array(AgentMessageRecordSchema).describe("Oldest first (seq ascending)"),
});
export type AgentMessageListResponse = z.infer<typeof AgentMessageListResponseSchema>;
