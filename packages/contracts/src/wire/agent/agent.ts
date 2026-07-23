import type { z } from "zod";
import { AgentSpecSchema } from "../../harness/agent-spec.js";

// GET /agents/:id/versions/:version 200 — the full AgentSpec. SSOT: @everdict/contracts.
export const AgentResponseSchema = AgentSpecSchema;
export type AgentResponse = z.infer<typeof AgentResponseSchema>;
