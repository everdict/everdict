import { z } from "zod";

// POST /datasets/validate 200 — dry-run outcome. Schema failures come back as ok:false (not 400).
export const ValidateDatasetResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    id: z.string(),
    version: z.string(),
    cases: z.number().int().describe("Case count of the submitted dataset"),
    existingVersions: z.array(z.string()).describe("Versions this workspace registered directly (no _shared fallback)"),
    versionExists: z.boolean().describe("True when the submitted version collides with an existing one"),
  }),
  z.object({
    ok: z.literal(false),
    errors: z.array(z.string()).describe("Schema issues (path: message)"),
    existingVersions: z.array(z.string()),
    versionExists: z.boolean(),
  }),
]);
export type ValidateDatasetResult = z.infer<typeof ValidateDatasetResultSchema>;
