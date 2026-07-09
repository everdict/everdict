import { z } from "zod";

// POST /runtimes 201 — registered coordinates.
export const RegisterRuntimeResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
});
