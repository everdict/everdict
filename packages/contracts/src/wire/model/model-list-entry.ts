import { z } from "zod";

// GET /models 200 — one entry per model id (workspace-owned + _shared fallback).
export const ModelListEntrySchema = z.object({
  id: z.string(),
  versions: z.array(z.string()).describe("Versions (semver ascending)"),
  owner: z.string().describe("Owning tenant, or _shared for first-party models"),
});
export type ModelListEntry = z.infer<typeof ModelListEntrySchema>;

export const ModelListResponseSchema = z.array(ModelListEntrySchema);
export type ModelListResponse = z.infer<typeof ModelListResponseSchema>;
