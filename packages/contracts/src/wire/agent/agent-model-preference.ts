import { z } from "zod";

// GET / PUT /agent/model 200 — the caller's OWN default LLM for their conversations, the third channel of the member
// overlay beside tools and skills. Two values, because a default is only meaningful next to what it replaces: what
// THIS member chose, and what they follow while they choose nothing.
// The options are NOT here: which models a member may pick from is `GET /models` (registered models, `_shared` tier
// included, under the visible-team ceiling that read already applies) — one answer to "what exists", not a second one
// that drifts from it.
export const AgentModelPreferenceResponseSchema = z.object({
  model: z.string().nullable().describe("THIS member's default model id — null = they follow the workspace baseline"),
  workspaceDefault: z
    .string()
    .nullable()
    .describe("The workspace agent's model (AgentSpec.model) — what null above resolves to; null = the server default"),
});
export type AgentModelPreferenceResponse = z.infer<typeof AgentModelPreferenceResponseSchema>;
