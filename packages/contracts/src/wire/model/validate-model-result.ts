import { z } from "zod";

// POST /models/validate 200 — dry-run outcome. Schema failures come back as ok:false (not 400).
export const ValidateModelResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    provider: z.string().describe("Model provider (e.g. anthropic | openai)"),
    id: z.string(),
    version: z.string(),
    existingVersions: z.array(z.string()).describe("Versions this workspace registered directly (no _shared fallback)"),
    versionExists: z.boolean().describe("True when the submitted version collides with an existing one"),
    missingSecrets: z
      .array(z.string())
      .optional()
      .describe("Referenced apiKeySecret name(s) not yet set in this workspace's SecretStore (warning, not a failure)"),
  }),
  z.object({
    ok: z.literal(false),
    errors: z.array(z.string()).describe("Schema issues (path: message)"),
    existingVersions: z.array(z.string()),
    versionExists: z.boolean(),
  }),
]);
export type ValidateModelResult = z.infer<typeof ValidateModelResultSchema>;
