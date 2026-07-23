import { z } from "zod";

// POST /agents 201 — registered coordinates.
export const RegisterAgentResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
});
export type RegisterAgentResult = z.infer<typeof RegisterAgentResultSchema>;
