import { z } from "zod";

// POST /agents/validate 200 — dry-run outcome. Schema failures come back as ok:false (not 400). missingSecrets warns
// about any mcpServers[].authSecret name not yet set in this workspace's SecretStore (surfaced before registration, not
// a hard failure — the secret can be added later).
export const ValidateAgentResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    id: z.string(),
    version: z.string(),
    existingVersions: z.array(z.string()).describe("Versions this workspace registered directly (no _shared fallback)"),
    versionExists: z.boolean().describe("True when the submitted version collides with an existing one"),
    missingSecrets: z
      .array(z.string())
      .optional()
      .describe("Referenced authSecret name(s) not yet set in this workspace's SecretStore (warning, not a failure)"),
  }),
  z.object({
    ok: z.literal(false),
    errors: z.array(z.string()).describe("Schema issues (path: message)"),
    existingVersions: z.array(z.string()),
    versionExists: z.boolean(),
  }),
]);
export type ValidateAgentResult = z.infer<typeof ValidateAgentResultSchema>;
