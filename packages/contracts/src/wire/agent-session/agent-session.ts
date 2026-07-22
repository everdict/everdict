import type { z } from "zod";
import { AgentSessionRecordSchema } from "../../records/agent-session.js";

// Single-session response — the AgentSessionRecordSchema IS the SSOT (id/tenant/owner/title/createdAt/updatedAt).
export const AgentSessionResponseSchema = AgentSessionRecordSchema;
export type AgentSessionResponse = z.infer<typeof AgentSessionResponseSchema>;
