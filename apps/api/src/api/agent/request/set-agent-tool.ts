import { z } from "zod";

// PUT /agent/tools · PUT /agent/skills — one member's decision about ONE entry of their own agent.
// `enabled: null` REMOVES the override (the member goes back to following the workspace baseline) — deliberately
// distinct from storing today's baseline value, which would freeze them at it.
export const SetAgentToolBodySchema = z
  .object({
    key: z.string().min(1).describe("Key from GET /agent/tools or GET /agent/skills"),
    enabled: z.boolean().nullable().describe("true = on for me · false = off for me · null = follow the workspace"),
  })
  .strict();
export type SetAgentToolBody = z.infer<typeof SetAgentToolBodySchema>;
