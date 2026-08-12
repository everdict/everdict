import { z } from "zod";

// PUT /agent/model — the calling member's own default LLM for their conversations.
// `model: null` CLEARS the pick (back to the workspace agent's model, then the server default) — deliberately distinct
// from storing today's baseline id, which would freeze the member at it while the workspace moved on.
export const SetAgentModelBodySchema = z
  .object({
    model: z
      .string()
      .min(1)
      .nullable()
      .describe("Registered model id from GET /models · null = follow the workspace default"),
  })
  .strict();
export type SetAgentModelBody = z.infer<typeof SetAgentModelBodySchema>;
