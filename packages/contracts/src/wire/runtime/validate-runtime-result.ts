import { z } from "zod";

// POST /runtimes/validate 200 — dry-run outcome. Schema failures come back as ok:false (not 400).
export const ValidateRuntimeResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    kind: z.string().describe("Runtime kind (local | nomad | k8s)"),
    id: z.string(),
    version: z.string(),
    existingVersions: z.array(z.string()).describe("Versions this workspace registered directly (no _shared fallback)"),
    versionExists: z.boolean().describe("True when the submitted version collides with an existing one"),
    missingSecrets: z
      .array(z.string())
      .optional()
      .describe(
        "Referenced secret names (authSecret/kubeconfigSecret) not present in this workspace's SecretStore — " +
          "a warning, not a hard failure (the secret can be added later)",
      ),
  }),
  z.object({
    ok: z.literal(false),
    errors: z.array(z.string()).describe("Schema issues (path: message)"),
    existingVersions: z.array(z.string()),
    versionExists: z.boolean(),
  }),
]);
