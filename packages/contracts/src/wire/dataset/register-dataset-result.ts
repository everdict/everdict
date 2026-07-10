import { z } from "zod";

// POST /datasets 201 — registered coordinates.
export const RegisterDatasetResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
});
export type RegisterDatasetResult = z.infer<typeof RegisterDatasetResultSchema>;
